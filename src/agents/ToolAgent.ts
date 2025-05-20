import { StateFlow } from '../core/StateFlow';
import { StateContext, StateDescriptor } from '../core/types';
import { StateNode } from '../core/StateNode';
import { AgentOptions, AgentTool, AgentToolResult, AgentPlanResult } from './types';
import { LlmError, LlmMessage, LlmProvider, LlmResponse } from '../llm/types';

function harmonizeSpacing(str: string): string {
    let firstline = str.split('\n')[0];
    let baselineSpacing: string = firstline.match(/^\s*/)?.[0] || '';
    return str.replace(new RegExp(`^${baselineSpacing}`, 'gm'), '');
}

export class ToolAgent extends StateFlow {
    private _tools: AgentTool[];
    public readonly maxRetry: number;
    public readonly provider: LlmProvider;

    private _planPrompt = `
    You are a helpful assistant that can use tools to help the user.
    Your goal is to complete the task using the tools provided.
    You will be given a task and a list of tools you can use to help the user.
    You will need to decide which tool to use and what parameters to pass to the tool.
    You will need to decide if you need to call the tool again or if you can proceed to solve the task.
    `;

    private renderPlanPrompt(): string {
        let planPrompt = harmonizeSpacing(this._planPrompt);
        planPrompt += `\n\nTOOLS: \n${this._tools.map(t => JSON.stringify({name: t.name, description: t.description, parameters: t.parameters})).join('\n')}`;
        return planPrompt;
    }

    private renderUserPrompt(text: string): string {
        let userPrompt = harmonizeSpacing(`
        ${text}
        
        WHATS NEXT? WRITE ONE PLAN IN RESPONSE TO THE USER PROMPT!
        ANSWER in FOLLOWING JSON FORMAT:
        {
            plan: <string, note: try to understand the task, then your plan what to do next, decide whether it is calling a tool, you are finished with the result>,
            action: <string, note: "tool" or "finish">,
            answer?: <string, note: your answer to the task if you are finished>
            toolCalls?: [{
                id: <string, tool call id>,
                tool: <string, tool name, must be one of the tools provided, dont add any prefix or suffix>,
                args: <{...}, arguments>
            }]
        } <--- SINGLE PLAN OBJECT, DO NOT WRITE MORE THAN ONE PLAN OBJECT!

        STOP AFTER ...}
        `)
        return userPrompt;
    }

    constructor(provider: LlmProvider, options: AgentOptions) {
        super([
            /**
             * Start: Start the agent
             */
            {
                name: 'Start',
                onState: async ctx => {
                    let messages: LlmMessage[] = [
                        {
                            role: 'system',
                            content: this.renderPlanPrompt()
                        },
                        {
                            role: 'user',
                            content: this.renderUserPrompt(`Task: ${ctx.input()}`)
                        }
                    ];

                    ctx.output(messages);
                    
                    return ctx;

                },
                router: { next: 'Plan' }
            },

            /**
             * Plan: Plan the next tool to call
             */
            {
                name: 'Plan',
                onState: async ctx => {
                    let messages = ctx.input<LlmMessage[]>();
                    try {
                        let result = await this.provider.generate(messages, {mode: 'json', model: 'gpt-4.1-mini'});
                        ctx.output({
                            messages: messages,
                            result: result
                        });
                    } catch (error) {
                        console.error(error);
                        if (error instanceof LlmError) {
                            ctx.error(error.message);
                        }
                    }
                    return ctx;
                },
                router: {
                    routes: {
                        ToolCall: {
                            description: 'Call tools',
                            map: (o) => ({messages: o.messages, result: o.result.data})
                        },
                        Finish: {
                            description: 'Done',
                            map: (o) => o.result.data.answer
                        }
                    },
                    onRoute: async (ctx: StateContext) => {
                        let output = ctx.output<{ messages: LlmMessage[], result: LlmResponse }>();
                        if (output) {
                            let {messages, result} = output;
                            if (result.data) {
                                let data = result.data as AgentPlanResult;
                                if (data.toolCalls) {
                                    return 'ToolCall';
                                } else if (data.answer) {
                                    return 'Finish';
                                }
                            }
                        }
                        return 'Finish';
                    }
                }
            },

            /**
             * ToolCall: Call the tool
             */
            {
                name: 'ToolCall',
                onState: async ctx => {
                    let {messages, result} = ctx.input<{messages: LlmMessage[], result: AgentPlanResult}>();
                    if (result.toolCalls) {
                        const toolCalls = result.toolCalls;
                        const toolResults: AgentToolResult[] = await Promise.all(toolCalls.map(async (toolCall) => {
                            const toolName = toolCall.tool;
                            const params = toolCall.args;
                            const result = await this.callTool(toolName, params, ctx);
                            return { id: toolCall.id, name: toolName, params, result: JSON.stringify(result || "") };
                        }));

                        messages.push({
                            role: 'user',
                            content: this.renderUserPrompt(`Tool call results: ${JSON.stringify(toolResults)}`)
                        });

                        ctx.output(messages);
                    }
                    return ctx;
                },
                router: { next: 'Plan' }
            },

            /**
             * Finish: Finish the agent
             */
            {
                name: 'Finish',
                onState: async ctx => {
                    if (ctx.input()) {
                        ctx.output(ctx.input());
                    }
                    return ctx;
                }
            }
        ], {
            plugins: options.plugins,
            startState: 'Start',
            maxSteps: options.maxSteps,
        });
        this._tools = options.tools ?? [];
        this.maxRetry = options.maxRetry ?? 3;
        this.provider = provider;
    }

    public tools(): AgentTool[] {
        return this._tools;
    }

    public tool(name: string): AgentTool | undefined {
        return this._tools.find(t => t.name === name);
    }

    public async callTool(name: string, params: any, ctx: StateContext): Promise<any> {
        const tool = this.tool(name);
        if (!tool) throw new Error(`Tool '${name}' not found`);
        return tool.handler(params, ctx);
    }
} 