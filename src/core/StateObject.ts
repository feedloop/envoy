import { Json, JsonObject } from "../types";
import { SerializedState, StateContext, WaitFor, WaitingContext } from "./types";
import { v4 as uuidv4 } from 'uuid';

export class StateObject implements StateContext {

    private _output?: Json;
    private _waiting: {
        [key: string]: WaitingContext
    }
    private _data: JsonObject;
    private _execState: "enter" | "state" | "waiting" | "exit"| "finish" = "enter";
    private _error: string | null = null;

    constructor(
        private _state: string, 
        private _step: number, 
        private _input: Json,
        private _done: "finished" | "error" | "cancelled" | "maxSteps" | null = null) {
        this._waiting = {};
        this._data = {};
    }

    public resetExecState(): void {
        this._execState = "enter";
    }

    public cycleExecState(): void {
        if (this._execState === "enter") {
            this._execState = "state";
        } else if (this._execState === "state") {
            this._execState = "waiting";
        } else if (this._execState === "waiting") {
            this._execState = "exit";
        } else if (this._execState === "exit") {
           this._execState = "finish";
        }
    }

    public execState(): "enter" | "state" | "waiting" | "exit" | "finish" {
        return this._execState;
    }

    public done(): "finished" | "error" | "cancelled" | "maxSteps" | null {
        return this._done;
    }

    public setDone(done: "finished" | "error" | "cancelled" | "maxSteps" | null = "finished"): void {
        this._done = done;
    }

    public state(): string {
        return this._state;
    }

    public step(): number {
        return this._step;
    }

    public error(msg: string): void {
        this._done = "error";
        this._error = msg;
    }

    public setState(state: string): void {
        this._state = state;
    }

    public setStep(step: number): void {
        this._step = step;
    }

    public input<T extends Json>(): T {
        return this._input as T;
    }

    public setInput<T extends Json>(input: T): void {
        this._input = input;
    }

    public output<T extends Json>(output?: T): T | undefined {
        if (arguments.length > 0) {
            this._output = output;
        }
        return this._output as T | undefined;
    }

    public clearOutput(): void {
        this._output = undefined;
    }

    public waitFor(waitlist: WaitFor[]): void {
        for (let item of waitlist) {
            this._waiting[item.id] = {
                id: item.id,
                type: item.type,
                status: "pending",
                params: item.params,
            }
        }
    }

    public isWaitingFor(): string[] {
        let list: string[] = [];
        for (let id in this._waiting) {
            if (this._waiting[id].status === "pending") {
                list.push(id);
            }
        }
        return list;
    }

    public resolve(id: string, status: "success" | "error", outputOrError?: Json): void {
        if (!(id in this._waiting)) {
            return;
        }
        let waiting = this._waiting[id];
        if (status === "success") {
            this._waiting[id] = {
                id: id,
                type: waiting.type,
                status: "success",
                output: outputOrError,
            }
        } else {
            this._waiting[id] = {
                id: id,
                type: waiting.type,
                status: "error",
                error: outputOrError,
            }
        }
    }

    public set<T extends Json>(key: string, value: T): void {
        this._data[key] = value;
    }

    public get<T extends Json>(key: string): T {
        return this._data[key] as T;
    }

    public clone(newId = false): StateObject {
        let clone = new StateObject(this._state, this._step, this._input);
        clone._output = this._output;
        clone._waiting = {...this._waiting};
        clone._data = {...this._data};
        clone._execState = this._execState;
        return clone;
    }

    public serialize(): SerializedState {
        return {
            state: this._state,
            step: this._step,
            input: this._input,
            output: this._output || null,
            done: this._done,
            execState: this._execState,
            waiting: this._waiting,
            data: this._data,
        }
    }

    static from(json: SerializedState): StateObject {
        let state = new StateObject(json.state, json.step, json.input);
        state._output = json.output;
        state._done = json.done;
        state._waiting = json.waiting;
        state._data = json.data;
        state._execState = json.execState;
        return state;
    }

    static fromContext(ctx: StateContext): StateObject {
        return ctx as StateObject;
    }
}