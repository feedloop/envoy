# Envoy Workflow & Job Scheduler

## 1. Project Overview

Envoy is a modular, extensible workflow engine and job scheduler for AI use cases built on Node.js, PostgreSQL, and Redis. It enables robust orchestration of complex, multi-step jobs using state machines, with support for parent/child workflows, retries, blocking, and distributed execution.

**Key Features:**
- State machine-driven job orchestration
- Parent/child (spawn) workflows
- Blocking, waiting, and external event resolution
- Robust retry and orphaned job cleanup
- Pluggable state machines and custom job types
- PostgreSQL for durability, Redis for fast distributed coordination

---

## 2. Architecture

- **Scheduler:** Orchestrates job execution, manages queues, retries, and blocking.
- **StateMachine:** Defines workflow logic as a series of states and transitions.
- **JobRepo:** Persists jobs and their state in PostgreSQL.
- **Redis:** Used for distributed job queues, locks, and fast status checks.

```
[Client/API] → [Scheduler] → [StateMachine] → [JobRepo (Postgres)]
                                 ↓
                              [Redis]
```

---

## 3. Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- PostgreSQL (14+)
- Redis (6+)

### Installation
```sh
npm install
```

### Environment Variables
Copy `.env.example` to `.env` and fill in your database and Redis connection details:

### StateMachine Concept: Minimal Example

A StateMachine is a workflow defined as a series of named states (nodes) and transitions. Each state can perform logic and decide what state to go to next.

```ts
import { StateMachine } from './src/core/StateMachine';

const sm = new StateMachine([
  {
    name: 'Start',
    onState: async ctx => {
      ctx.output('Hello!');
      return ctx;
    },
    router: { next: 'Middle' }
  },
  {
    name: 'Middle',
    onState: async ctx => {
      ctx.output(ctx.output() + ' Middle!');
      return ctx;
    },
    router: { next: 'End' }
  },
  {
    name: 'End',
    onState: async ctx => {
      ctx.output(ctx.output() + ' End!');
      return ctx;
    },
    router: { next: null }
  }
]);

(async () => {
  const ctx = await sm.run();
  console.log(ctx.output()); // "Hello! Middle! End!"
})();
```

---

### Routing Between States

Routing determines which state to transition to next after a state handler completes. There are two main approaches:

#### 1. Static Routing
Use `router: { next: 'StateName' }` to always go to a specific state:

```ts
{
  name: 'A',
  onState: async ctx => { /* ... */ return ctx; },
  router: { next: 'B' }
}
```

#### 2. Dynamic Routing (Router Function)
Use a `router` function to decide the next state based on context, output, or any logic:

```ts
{
  name: 'A',
  onState: async ctx => {
    ctx.output(Math.random());
    return ctx;
  },
  router: {
    onRoute: async ctx => {
      const value = ctx.output<number>();
      if (value > 0.5) {
        return { state: 'B', input: value };
      } else {
        return { state: 'C', input: value };
      }
    }
  }
}
```

- The router function can return `{ state: 'NextState', input: ... }` to pass input to the next state.
- You can implement conditional branching, loops, or even end the workflow by returning `{ state: null }`.

#### 3. Example: Conditional Branching

```ts
{
  name: 'Check',
  onState: async ctx => {
    ctx.output(ctx.input<number>());
    return ctx;
  },
  router: {
    onRoute: async ctx => {
      return ctx.output<number>() > 10
        ? { state: 'Big', input: ctx.output() }
        : { state: 'Small', input: ctx.output() };
    }
  }
},
{
  name: 'Big',
  onState: async ctx => { ctx.output('Big number!'); return ctx; },
  router: { next: null }
},
{
  name: 'Small',
  onState: async ctx => { ctx.output('Small number!'); return ctx; },
  router: { next: null }
}
```

This allows you to build complex, data-driven workflows with flexible transitions between states.

---

### State Handlers: onEnter, onState, onExit

- `onEnter`: Runs when entering the state (optional).
- `onState`: Main logic for the state (required).
- `onExit`: Runs when leaving the state (optional).

```ts
{
  name: 'Example',
  onEnter: async ctx => { ctx.set('entered', true); return ctx; },
  onState: async ctx => { /* main logic */ return ctx; },
  onExit: async ctx => { ctx.set('exited', true); return ctx; },
  router: { next: null }
}
```

---

### The ctx Object: input, output, set, get

- `ctx.input<T>()`: Get the input for this state.
- `ctx.output<T>(value?)`: Set or get the output for this state.
- `ctx.set(key, value)`: Store arbitrary data in the context.
- `ctx.get<T>(key)`: Retrieve stored data.

```ts
onState: async ctx => {
  const input = ctx.input<string>();
  ctx.set('foo', 42);
  ctx.output('Result: ' + input);
  return ctx;
}
```

---

### Spawning Child Jobs

You can spawn child jobs from a parent job and wait for their results:

```ts
onState: async ctx => {
  ctx.spawn('childWorkflow', { some: 'input' });
  return ctx;
}
```
- The parent job will block until the child job completes, then resume and receive the child's output.

---

### Plugins: Extending StateMachine Behavior

Plugins allow you to extend or intercept state transitions, add logging, metrics, or custom logic:

```ts
const myPlugin = {
  name: 'logger',
  onEnter: (ctx, state) => { console.log('Entering', state); },
  onExit: (ctx, state) => { console.log('Exiting', state); }
};

const sm = new StateMachine([...], { plugins: [myPlugin] });
```
- Plugins can hook into `onEnter`, `onExit`, and other lifecycle events.

---

## 4. Database Setup & Migrations

### Initialize the Database
```sh
npm run migrate
```

### Clean & Recreate Test Database
```sh
npm run migrate -- --clean
```

---

## 5. Running the Application

### Local Development
```sh
npm run dev
```

### With Docker (if available)
```sh
docker-compose up --build
```

---

## 6. Job & Workflow Concepts

- **Job:** A unit of work tracked in the database, processed by a state machine.
- **State Machine:** Defines the workflow logic for a job, with named states and transitions.
- **Parent/Child Jobs:** A job can spawn child jobs and wait for their results.
- **Blocking/Waiting:** Jobs can block on external events or child jobs, and resume when unblocked.
- **Retries:** Jobs can be retried on failure up to a configurable limit.

---

## 7. API Usage

### Scheduling a Job
```ts
const jobId = await scheduler.schedule('myWorkflow', { input: 'data' });
```

### Querying Job Status
```ts
const job = await scheduler.getJob(jobId);
console.log(job.status); // 'pending', 'running', 'done', 'failed', etc.
```

### Cancelling or Failing a Job
```ts
await scheduler.cancelJob(jobId);
await scheduler.failJob(jobId, 'reason');
```

### Resolving a Blocking Job
```ts
await scheduler.resolveBlockingJob(jobId, 'waitForId', { result: 42 });
```

---

## 8. Testing

### Run the Test Suite
```sh
npm test
```

- The test database is dropped and recreated before tests for isolation.
- Tests cover job scheduling, parent/child workflows, blocking, retries, and orphaned job cleanup.

---

## 9. Implementing a State Machine (Example: ToolAgent)

You can implement custom state machines for your workflows. Here's an example using the built-in `ToolAgent`, which plans and executes tool calls using an LLM:

```ts
import { ToolAgent } from './src/agents/ToolAgent';
import { OpenAIProvider } from './src/llm/OpenAIProvider';

// Define your tools
const tools = [
  {
    name: 'add',
    description: 'Add two numbers',
    parameters: { a: 'number', b: 'number' },
    handler: async ({ a, b }) => a + b,
  },
  {
    name: 'echo',
    description: 'Echo a string',
    parameters: { text: 'string' },
    handler: async ({ text }) => text,
  },
];

// Create an LLM provider (e.g., OpenAI)
const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });

// Instantiate the ToolAgent state machine
const agent = new ToolAgent(provider, {
  tools,
  maxSteps: 10,
});

// Run the agent with a task
(async () => {
  const ctx = await agent.run('What is 2 + 2?');
  console.log('Final output:', ctx.output());
})();
```

- **Define tools** with a name, description, parameters, and handler function.
- **Instantiate ToolAgent** with your tools and an LLM provider.
- **Run the agent** with a user task; the agent will plan, call tools, and return the result.

You can implement your own state machines by extending `StateMachine` and defining custom states and transitions for your workflow needs.

---

## 10. Contributing

- Fork the repo and create a feature branch.
- Write tests for new features or bug fixes.
- Follow code style and submit a pull request.

---

## 11. License

MIT

---

## 12. Acknowledgments

- Inspired by workflow engines, distributed job systems, and state machine libraries.
- Thanks to all contributors and open source libraries used in this project. 