# Envoy: Modular State Machine Agent Framework

## Overview

Envoy is a modular, extensible framework for building state machine-driven agents that can leverage LLMs (like OpenAI) and custom tools. It is designed for orchestrating complex, multi-step reasoning and tool-use workflows, with a clear separation between state management, agent logic, and LLM/tool integration.

---

## Directory Structure

- `src/llm/` — LLM provider abstraction and OpenAI integration.
- `src/core/` — State machine engine, nodes, context, and plugin system.
- `src/agents/` — Agent implementations (e.g., `ToolAgent`) and agent-specific types.

---

## Core Concepts

### State Machine Engine (`src/core`)

- **StateMachine**: Orchestrates transitions between states, supports plugins, and manages execution flow.
- **StateNode**: Represents a state; handles `onEnter`, `onState`, `onExit`, and routing logic.
- **StateObject**: Implements the context passed between states, tracking input, output, waiting, and execution state.
- **Plugins**: Extend or intercept state transitions and routing.

### LLM Integration (`src/llm`)

- **LlmProvider**: Abstract interface for LLMs.
- **OpenAIProvider**: Implements `LlmProvider` for OpenAI's API, supporting tool calls and structured (JSON/XML) responses.
- **LlmMessage**: Unified message format for user, assistant, system, and tool messages.

### Agent Layer (`src/agents`)

- **ToolAgent**: A state machine agent that plans, calls tools, and produces answers using an LLM.
- **AgentTool**: Defines a tool (name, description, parameters, handler).
- **AgentOptions**: Configures tools, plugins, prompts, and execution limits.

---

## Example: Creating a Custom StateMachine

You can use the core state machine engine directly to model any workflow. Here is a minimal example with two states and a transition:

```ts
import { StateMachine } from './src/core/StateMachine';
import { StateDescriptor, StateContext } from './src/core/types';

const states: StateDescriptor[] = [
  {
    name: 'Start',
    onState: async (ctx) => {
      ctx.output('Hello from Start!');
      return ctx;
    },
    router: { next: 'End' }
  },
  {
    name: 'End',
    onState: async (ctx) => {
      ctx.output('Reached End.');
      return ctx;
    },
    router: { next: null }
  }
];

const sm = new StateMachine(states, { startState: 'Start' });

(async () => {
  const ctx = await sm.run('Initial input');
  console.log(ctx.serialize());
})();
```

---

## Working with the State Context (`ctx`)

The `ctx` object (context) is passed to every state handler and provides methods for managing state, data, and flow. Here are the most common operations:

### Accessing Input and Output

```ts
// Get the input provided to this state
const input = ctx.input<string>();

// Set or get the output for this state
ctx.output('Some result');
const result = ctx.output<string>();
```

### Storing and Retrieving Data

```ts
// Store arbitrary data in the context
ctx.set('myKey', 42);

// Retrieve stored data
const value = ctx.get<number>('myKey');
```

### Waiting for External Events

```ts
// Wait for an external event (e.g., async operation, user input)
ctx.waitFor([
  { id: 'wait1', type: 'external', params: { info: 'something' } }
]);

// Check if still waiting
if (ctx.isWaitingFor().length > 0) {
  // handle waiting logic
}

// Resolve a waiting event
ctx.resolve('wait1', 'success', { data: 'done' });
```

### Error Handling

```ts
// Mark the context as errored
ctx.error('Something went wrong');

// Check if the state machine is done due to error
if (ctx.done() === 'error') {
  // handle error
}
```

### Cloning and Serializing Context

```ts
// Clone the context (useful for immutability in transitions)
const newCtx = ctx.clone();

// Serialize for logging or persistence
console.log(ctx.serialize());
```

---

## StateMachine and StateContext Interfaces

### StateMachine (class)

The `StateMachine` class provides the main API for orchestrating state transitions:

```ts
class StateMachine<T extends StateContext = StateContext> {
  constructor(states: StateDescriptor[], options?: StateMachineOptions);
  nodes(): StateNode[];
  node(name: string): StateNode | null;
  addNode(node: StateNode, start?: boolean): void;
  plugins(): StateMachinePlugin[];
  plugin(name: string): StateMachinePlugin | null;
  addPlugin(plugin: StateMachinePlugin): void;
  step(ctx: T): Promise<T>;
  newContext(input: string): T;
  run(input: string): Promise<T>;
  drawGraph(): string;
}
```

- **nodes()**: List all state nodes.
- **node(name)**: Get a node by name.
- **addNode(node, start?)**: Add a node (optionally as start).
- **plugins() / plugin(name) / addPlugin(plugin)**: Manage plugins.
- **step(ctx)**: Advance the state machine by one step.
- **newContext(input)**: Create a new context for a run.
- **run(input)**: Run the state machine to completion.
- **drawGraph()**: Output a graphviz diagram of the state machine.

### StateContext (interface)

The `StateContext` interface defines the context object passed between states:

```ts
interface StateContext {
  state(): string;
  step(): number;
  input<T>(): T;
  done(): "finished" | "error" | "cancelled" | "maxSteps" | null;
  output<T>(output?: T): T | undefined;
  waitFor(waitlist: WaitFor[]): void;
  isWaitingFor(): string[];
  set<T>(key: string, value: T): void;
  get<T>(key: string): T;
  clone(): StateContext;
  serialize(): SerializedState;
  // ...other properties and methods
}
```

- **state()**: Current state name.
- **step()**: Current step number.
- **input()**: Input for this state.
- **done()**: Completion status.
- **output()**: Set/get output for this state.
- **waitFor() / isWaitingFor() / resolve()**: Manage waiting for external events.
- **set() / get()**: Store/retrieve arbitrary data.
- **clone()**: Clone the context.
- **serialize()**: Serialize for logging or persistence.

See the "Working with the State Context (`ctx`)" section above for usage examples.

---

## Example: ToolAgent Flow

1. **Start**: Receives a user task, builds a prompt for the LLM.
2. **Plan**: LLM decides whether to call a tool or finish, returning a structured plan.
3. **ToolCall**: Executes tool(s) as per the plan, feeds results back to the LLM.
4. **Finish**: Returns the final answer.

```ts
import { ToolAgent } from './src/agents/ToolAgent';
import { OpenAIProvider } from './src/llm/openai';

const tools = [
  {
    name: 'echo',
    description: 'Echoes the input text',
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: async (params) => ({ echoed: params.text })
  }
];

const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, tools, model: 'gpt-4o-mini' });
const agent = new ToolAgent(provider, { tools });

const result = await agent.run('Echo hello world');
console.log(result.serialize());
```

---

## Testing

- End-to-end and integration tests are in `tests/`.
- Real OpenAI API calls are supported (set `OPENAI_API_KEY` in `.env`).

---

## License

MIT 