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
- **Flow:** Defines workflow logic as a series of states and transitions.
- **JobRepo:** Persists jobs and their state in PostgreSQL.
- **Redis:** Used for distributed job queues, locks, and fast status checks.

```
[Client/API] → [Scheduler] → [Flow] → [JobRepo (Postgres)]
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
In your project:
```sh
npm install @feedloop/envoy
```

### Flow Concept: Minimal Example

A Flow is a workflow defined as a series of named states (nodes) and transitions. Each state can perform logic and decide what state to go to next.

```ts
import { StateFlow } from '@feedloop/envoy';

const flow = new StateFlow([
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

const ctx = await sm.run();
console.log(ctx.output()); // "Hello! Middle! End!"
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
    // define the routes
    routes: {
      B: {
        description: "route to B"
      },
      C: {
        description: "route to C"
      }
    }
    onRoute: async ctx => {
      const value = ctx.output<number>();
      if (value > 0.5) {
        return 'B';
      } else {
        return 'C';
      }
    }
  }
}
```

- You can implement conditional branching, loops, or even end the workflow by returning null.

#### 3. Example: Conditional Branching

```ts
{
  name: 'Check',
  onState: async ctx => {
    ctx.output(ctx.input<number>());
    return ctx;
  },
  router: {
    routes: {
      Big: o => o,
      Small: o => o
    }
    onRoute: async ctx => {
      return ctx.output<number>() > 10
        ? 'Big'
        : 'Small'
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

### The ctx Object
The `ctx` object (short for "context") is passed to every state handler and provides methods to access and manipulate the state machine's execution context. It allows you to:

- Access the current state's input and output.
- Store and retrieve arbitrary data across states.
- Control execution flow (e.g., spawn child jobs, escalate, wait for events).
- Track progress, state name, and step count.

Common `ctx` methods include:

- `ctx.input<T>()`: Get the input for this state, optionally typed.
- `ctx.output<T>(value?)`: Set or get the output for this state.
- `ctx.set(key, value)`: Store custom data in the context.
- `ctx.get<T>(key)`: Retrieve custom data from the context.
- `ctx.state()`: Get the current state name.
- `ctx.step()`: Get the current step number.
- `ctx.done()`: Check if the workflow is finished or in a terminal state.
- `ctx.spawn(workflowName, input)`: Spawn a child workflow/job.
- `ctx.waitFor(waitList)`: Block until external input or events are received.
- `ctx.escalate(user, message, inputs)`: Escalate to a human or external system for intervention.

The `ctx` object is a new context instance, so always return the updated `ctx` from your handler. immutable by default—modifications return

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

### Plugins: Extending  Behavior

Plugins allow you to extend or intercept state transitions, add logging, metrics, or custom logic:

```ts
const myPlugin = {
  name: 'logger',
  onEnter: (ctx, state) => { console.log('Entering', state); },
  onExit: (ctx, state) => { console.log('Exiting', state); }
};

const sm = new StateFlow([...], { plugins: [myPlugin] });
```
- Plugins can hook into `onEnter`, `onExit`, and other lifecycle events.


## 4. Job & Workflow Concepts

- **Job:** A unit of work tracked in the database, processed by a state machine.
- **State Machine:** Defines the workflow logic for a job, with named states and transitions.
- **Parent/Child Jobs:** A job can spawn child jobs and wait for their results.
- **Blocking/Waiting:** Jobs can block on external events or child jobs, and resume when unblocked.

### Human-in-the-Loop Escalation
- **Escalation:** A job can trigger a human escalation, blocking until a human approves or rejects it. Escalations are tracked in the `escalations` table and can be listed, approved, or rejected via the API or repository.
- **How to trigger:** Use `ctx.escalate(user, message, inputs)` in your state machine to block and require human input. Example:

```ts
onState: async ctx => {
  ctx.escalate('alice', 'Approve this action?', [
    { id: 'reason', type: 'select', label: 'Reason', options: { a: 'A', b: 'B' } },
    { id: 'note', type: 'comment', label: 'Note' }
  ]);
  return ctx;
}
```
- **How to reply:** Use `scheduler.replyToEscalation(escalationId, { reason: 'a', note: 'Looks good' }, 'approved')` to approve, or use `'rejected'` to reject. The job will resume or error accordingly.

```ts
await scheduler.replyToEscalation(escalationId, { reason: 'a', note: 'OK' }, 'approved');
```
- **Escalation status:** Escalations can be `pending`, `approved`, or `rejected`. The job will unblock and continue after a reply.

- **Retries:** Jobs can be retried on failure up to a configurable limit.

---

## 5. API Usage

### Instantiate scheduler
```ts
// To quickly get started, use `initScheduler` to create a scheduler instance with a database and built-in workflows:

import { initScheduler } from '@feedloop/envoy';

const scheduler = await initScheduler({
  redis: {
    host: 'localhost',      // or your Redis host
    port: 6379,             // optional, default 6379
    password: 'yourpassword'// optional
  },
  postgres: {
    host: 'localhost',      // or your Postgres host
    port: 5432,             // optional, default 5432
    password: 'postgres',   // optional
    database: 'postgres'    // optional
  },
  concurrency: 2,           // optional, number of jobs to run in parallel
  maxRetries: 3             // optional, max retries per job
});
```

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

## 6. Implementing a State Machine (Example: ToolAgent)

You can implement custom state machines for your workflows. Here's an example using the built-in `ToolAgent`, which plans and executes tool calls using an LLM:

```ts
import { ToolAgent, OpenAIProvider } from '@feedloop/envoy';

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

const ctx = await agent.run('What is 2 + 2?');
console.log('Final output:', ctx.output());
```

- **Define tools** with a name, description, parameters, and handler function.
- **Instantiate ToolAgent** with your tools and an LLM provider.
- **Run the agent** with a user task; the agent will plan, call tools, and return the result.

You can implement your own state machines by extending `StateFlow` and defining custom states and transitions for your workflow needs.

---

## 7. Contributing

- Fork the repo and create a feature branch.
- Write tests for new features or bug fixes.
- Follow code style and submit a pull request.

---

## 8. License

MIT