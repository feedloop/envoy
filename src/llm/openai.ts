import OpenAI from 'openai';
import { Json, JsonObject } from '../types';
import { LlmProvider, LlmMessage, LlmConfig, LlmTool, LlmResponse, LlmError } from './types';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export class OpenAIProvider implements LlmProvider {
    readonly vendor = 'openai';
    readonly config: LlmConfig;
    private client: OpenAI;

    constructor(config: LlmConfig) {
        this.config = config;
        this.client = new OpenAI({ apiKey: config.apiKey, ...config.config });
    }

    async generate(
        messages: LlmMessage[], // Changed from string to LlmMessage[] to match Llm interface and OpenAI SDK
        config: LlmConfig = {}
    ): Promise<LlmResponse> {
        let cfg = {
            ...{model: 'gpt-4o-mini', mode: 'text'}, 
            ...this.config,
            ...config};
        // Map LlmMessage to OpenAI's ChatCompletionMessageParam
        const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map(msg => {
            if (msg.role === 'user') {
                const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [{ type: 'text', text: msg.content }];
                if (msg.attachments) {
                    for (const attachment of msg.attachments) {
                        if (attachment.type === 'image') {
                            contentParts.push({ type: 'image_url', image_url: { url: attachment.url } });
                        }
                        // Potentially handle other attachment types like 'file' here if needed in the future
                    }
                }
                return {
                    role: 'user',
                    content: contentParts.length > 1 ? contentParts : msg.content, // Use array only if there are attachments
                };
            }
            if (msg.role === 'assistant' && msg.tool_calls) {
                // Map tool_calls to OpenAI's expected format
                return {
                    role: msg.role,
                    content: msg.content,
                    tool_calls: msg.tool_calls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: {
                            name: tc.name,
                            arguments: JSON.stringify(tc.args),
                        },
                    })),
                };
            }
            if (msg.role === 'tool') {
                 return {
                    role: msg.role,
                    tool_call_id: msg.tool_call_id,
                    content: msg.content,
                };
            }
            return {
                role: msg.role,
                content: msg.content,
            };
        });

        const requestBody: OpenAI.Chat.ChatCompletionCreateParams = {
            model: cfg.model,
            messages: openaiMessages,
            stream: false,
            temperature: cfg.temperature ?? 0,
            ...this.config.config,
        };

        // Add tools to the request if present in config
        if (this.config.tools) {
            requestBody.tools = this.config.tools.map((tool: LlmTool) => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                }
            }));
            requestBody.tool_choice = 'auto';
        }

        if (cfg.mode === 'json') {
            requestBody.response_format = { type: 'json_object' };
        }
        // Note: OpenAI API doesn't have a specific 'xml' mode like 'json_object'.
        // Consumers would need to instruct the model to output XML via messages if that's desired.

        let completion: OpenAI.Chat.ChatCompletion;
        
        try {
            completion = await this.client.chat.completions.create(requestBody) as OpenAI.Chat.ChatCompletion;
        } catch (error) {
            if (error instanceof OpenAI.APIError) {
                throw {
                    message: error.message,
                    type: error.type,
                    code: error.code,
                } as LlmError;
            }
            throw {
                message: "unknown error",
                type: "unknown",
                code: "",
            } as LlmError;
        }

        const choice = completion.choices[0];
        const message = choice.message;

        let returnedToolCalls: {
            id: string;
            name: string;
            args: JsonObject;
        }[] | undefined = undefined;

        if (message.tool_calls) {
            returnedToolCalls = message.tool_calls.map(tc => {
                let parsedArgs: JsonObject = {};
                try {
                    // OpenAI returns arguments as a string, so we need to parse them.
                    parsedArgs = JSON.parse(tc.function.arguments);
                } catch (error) {
                    throw new LlmError(`Failed to parse arguments for tool call ${tc.id} (${tc.function.name}):`, "parse_error", "tool_call_arguments");
                }
                return {
                    id: tc.id,
                    name: tc.function.name,
                    args: parsedArgs,
                };
            });
        }

        let data: JsonObject | undefined = undefined;

        if (cfg.mode === 'json') {
            try {
                data = JSON.parse(message.content || '{}');
            } catch (error) {
                console.log(message.content);
                throw new LlmError(`Failed to parse JSON content: ${error}`, "parse_error", "json_content");
            }
        } else if (cfg.mode === 'xml') {
            if (message.content) {
                const parser = new XMLParser();
                try {
                    const validationResult = XMLValidator.validate(message.content);
                    if (validationResult === true) {
                        data = parser.parse(message.content) as JsonObject;
                    } else {
                        console.error("Invalid XML content:", validationResult.err);
                        data = { error: "Invalid XML content", details: validationResult.err, rawContent: message.content };
                    }
                } catch (error) {
                    throw new LlmError(`Failed to parse XML content: ${error}`, "parse_error", "xml_content");
                }
            } else {
                data = {}; 
            }
        }

        return {
            text: message.content,
            toolCalls: returnedToolCalls,
            data,
            usage: {
                promptTokens: completion.usage?.prompt_tokens ?? 0,
                completionTokens: completion.usage?.completion_tokens ?? 0,
                totalTokens: completion.usage?.total_tokens ?? 0,
            },
        };
    }
}
