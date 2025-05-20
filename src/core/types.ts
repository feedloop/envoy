import { Json, JsonObject, JsonSchema } from "../types";

export type StateFlowPlugin = {
    name: string;
    dependsOn?: string[];
    onEnter?: (state: StateContext) => Promise<StateContext>;
    onExit?: (state: StateContext) => Promise<StateContext>;
    onRoute?: (ctx: StateContext, proposedNext:string | null) => Promise<string | null>;
}

export type EscalationInput = SelectInput | CommentInput | ApproveInput;

type SelectInput = {
    id: string;
    type: "select";
    label: string;
    options: {
        [key: string]: string;
    }
}

type CommentInput = {
    id: string;
    type: "comment";
    label: string;
}

type ApproveInput = {
    id: string;
    type: "approve";
    label: string;
}



export type StateDescriptor = {
    name: string;
    router?: StateRouter;
    inputType?: JsonSchema;
    outputType?: JsonSchema;
    onEnter?: (ctx: StateContext) => Promise<StateContext>;
    onExit?: (ctx: StateContext) => Promise<StateContext>;
    onState: (ctx: StateContext) => Promise<StateContext>;
}

export type StateRouter = {next: string | null, map?: (output: any, ctx: StateContext) => any} | {
    routes: {
        [key: string]: ((output: any, ctx: StateContext) => any) | {
            description: string;
            default?: boolean;
            map?: (output: any, ctx: StateContext) => any;
        }
    }
    onRoute: (ctx: StateContext) => Promise<string | null>;
}

export type WaitFor = {
    id: string;
    type: string;
    params?: JsonObject;
}

export type WaitingContext = WaitFor & {
    status: "pending" | "success" | "error";
    output?: Json;
    error?: Json;
    childJobId?: string;
}

export type StateContext = {
    state(): string;
    step(): number;
    input<T extends Json>(): T;
    done(): "finished" | "error" | "cancelled" | "maxSteps" | null;
    output<T extends Json>(): T | undefined;
    output<T extends Json>(output: T): T | undefined;
    output<T extends Json>(path: string, value: T): void;
    waitFor(waitlist: WaitFor[]): void;
    isWaitingFor(): string[];
    spawn(sm: string, input: Json): string;
    escalate(user: string, message: string, inputs: EscalationInput[]): string;
    set<T extends Json>(key: string, value: T): void;
    get<T extends Json>(key: string): T;
    clone(newId?: boolean): StateContext;
    serialize(): SerializedState;
    [key: string]: any;
}

export type SerializedState = {
    state: string;
    step: number;
    input: Json;
    output: Json | null;
    execState: "enter" | "state" | "waiting" | "exit" | "finish";
    done: "finished" | "error" | "cancelled" | "maxSteps" | null;
    waiting: {
        [key: string]: WaitingContext
    };
    data: JsonObject;
}

export interface SchedulerOptions {
    concurrency?: number;
}