export type Json = string | number | boolean | null | JsonArray | JsonObject;
export type JsonObject = { [key: string]: Json };
export type JsonArray = Json[];

// full json schema definition
export type JsonSchema = {
    type: "object" | "string" | "number" | "boolean" | "array";
    properties?: {
        [key: string]: JsonSchema;
    };
    required?: string[];
    enum?: string[];
    description?: string;
    default?: Json;
}