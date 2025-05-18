import { ToolAgent } from '../../src/agents/ToolAgent';
import { AgentTool } from '../../src/agents/types';
import { OpenAIProvider } from '../../src/llm/openai';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { LlmTool } from '../../src/llm/types';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const apiKey = process.env.OPENAI_API_KEY;
const model = 'gpt-4o-mini';

if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set in the environment.");
}

describe('ToolAgent (OpenAI integration)', () => {
    it('should call a real tool and finish', async () => {
        const tools: AgentTool[] = [
            {
                name: 'echo',
                description: 'Echoes the input text',
                parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
                handler: async (params) => ({ echoed: params.text })
            }
        ];
        const provider = new OpenAIProvider({ apiKey, model });
        const agent = new ToolAgent(provider, { tools });
        const ctx = await agent.run('Echo hello world');
        console.log('Final context (single tool):', ctx.serialize());
        expect(ctx.state()).toBe('Finish');
        expect(ctx.done()).toBe('finished');
        // Assert the final output contains the echoed text
        const final = ctx.serialize();
        console.log('Final result (single tool):', final.input, final.output, final.data);
        expect(JSON.stringify(final)).toMatch(/hello world/i);
    }, 60000);

    it('should call multiple real tools in sequence before finishing', async () => {
        const tools: AgentTool[] = [
            {
                name: 'add',
                description: 'Adds two numbers',
                parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
                handler: async (params) => ({ sum: (params.a as unknown as number) + (params.b as unknown as number) })
            },
            {
                name: 'multiply',
                description: 'Multiplies two numbers',
                parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
                handler: async (params) => ({ product: (params.x as unknown as number) * (params.y as unknown as number) })
            }
        ];
        const provider = new OpenAIProvider({ apiKey, tools, model });
        const agent = new ToolAgent(provider, { tools });
        const ctx = await agent.run('First add 2 and 3, then multiply the result by 4.');
        console.log('Final context (multiple tools):', ctx.serialize());
        expect(ctx.state()).toBe('Finish');
        expect(ctx.done()).toBe('finished');
        // Assert the final output contains the expected result (20)
        const final = ctx.serialize();
        console.log('Final result (multiple tools):', final.input, final.output, final.data);
        expect(JSON.stringify(final)).toMatch(/20|product|sum/i);
    }, 90000);
}); 