import { Json, JsonObject, JsonSchema } from "../types";

export type LlmMessage = LLMUserMessage | LLMAssistantMessage | LLMSystemMessage | LLMToolMessage;

export type LLMUserMessage = {
    role: "user";
    content: string;
    attachments?: {
        type: "image" | "file";
        url: string;
    }[];
}

export type LLMAssistantMessage = {
    role: "assistant";
    content: string;
    tool_calls?: {
        id: string;
        name: string;
        args: JsonObject;
    }[];
}

export type LLMSystemMessage = {
    role: "system";
    content: string;
}

export type LLMToolMessage = {
    role: "tool";
    content: string;
    tool_call_id: string;
}

export type LlmConfig = {
    model?: string;
    mode?: "text" | "json" | "xml";
    apiKey?: string;
    tools?: LlmTool[];
    temperature?: number; // LLM sampling temperature (default: 0)
    config?: {
        [key: string]: Json;
    }
}

export type LlmTool = {
    name: string;
    description: string;
    parameters: JsonSchema;
}

export class LlmError extends Error {
    type: string;
    code: string;
    
    constructor(message: string, type: string, code: string) {
        super(message);
        this.name = "LlmError";
        this.type = type;
        this.code = code;
    }
}

export type LlmResponse = {
    text: string | null;
    toolCalls?: {
        id: string;
        name: string;
        args: JsonObject;
    }[];
    data?: JsonObject;
    usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    }
}


export type LlmProvider = {
    readonly vendor: string;
    readonly config: LlmConfig;
    generate(messages: LlmMessage[], config?: LlmConfig): Promise<LlmResponse>;
}