import { StateFlowPlugin, StateContext } from '../core/types';
import { LlmTool } from '../llm/types';
import { JsonObject } from '../types';

export type AgentTool = LlmTool & {
    handler: (params: JsonObject, ctx: StateContext) => Promise<any>;
};

export type AgentToolResult = {
    name: string;
    id: string;
    params: JsonObject;
    result: string;
}

export type AgentPlanResult = {
    plan: string;
    action: string;
    answer?: string;
    toolCalls?: {
        id: string;
        tool: string;
        args: JsonObject;
    }[];
}

export type AgentOptions = {
    tools?: AgentTool[];
    plugins?: StateFlowPlugin[];
    planPrompt?: string;
    model?: string;
    maxSteps?: number;
    maxRetry?: number;
};