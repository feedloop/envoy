import { OpenAIProvider } from '../../src/llm/openai';
import { LLMUserMessage, LLMToolMessage, LLMAssistantMessage } from '../../src/llm/types';
import { JsonObject } from '../../src/types';
import * as dotenv from 'dotenv';
import * as path from 'path'; // Import path module

// Construct an absolute path to the .env file in the project root
const projectRoot = path.resolve(__dirname, '../../'); 
const envPath = path.join(projectRoot, '.env');
const model = 'gpt-4o-mini';
dotenv.config({ path: envPath });

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
    console.error(`Attempted to load .env from: ${envPath}`);
    throw new Error("OPENAI_API_KEY is not set in the environment. Please ensure it is in your .env file and the path is correct.");
}

// Using a publicly available image for testing vision capabilities
// Replace with a more stable/specific image if needed, or ensure this one remains accessible
const testImageUrl = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a3/June_odd-eyed-cat.jpg/320px-June_odd-eyed-cat.jpg'; 

describe('OpenAIProvider Integration Tests', () => {
    let client: OpenAIProvider;

    beforeAll(() => {
        client = new OpenAIProvider({apiKey});
    });

    test('should generate a basic text response', async () => {
        const messages: LLMUserMessage[] = [
            { role: 'user', content: 'Hello, OpenAI! Briefly introduce yourself.' }
        ];
        const response = await client.generate(messages, {mode: 'text', model});

        expect(response).toBeDefined();
        expect(response.text).not.toBeNull();
        expect(typeof response.text).toBe('string');
        expect(response.text!.length).toBeGreaterThan(0);
        expect(response.usage.promptTokens).toBeGreaterThan(0);
        expect(response.usage.completionTokens).toBeGreaterThan(0);
        expect(response.usage.totalTokens).toBeGreaterThan(0);
        console.log("Basic text response:", response.text);
    }, 30000); // 30 second timeout for API call

    test('should generate a response in JSON mode', async () => {
        const messages: LLMUserMessage[] = [
            { role: 'user', content: 'Return a JSON object with two keys: "greeting" and "target", with values "Hello" and "World" respectively.' }
        ];
        const response = await client.generate(messages, {mode: 'json', model});

        expect(response).toBeDefined();
        expect(response.text).not.toBeNull(); // OpenAI might still return the JSON string in text
        expect(response.data).toBeDefined();
        expect(typeof response.data).toBe('object');
        expect(response.data!.greeting).toBe('Hello');
        expect(response.data!.target).toBe('World');
        console.log("JSON mode response data:", response.data);
    }, 30000);

    test('should attempt to generate a response in XML mode', async () => {
        const messages: LLMUserMessage[] = [
            { role: 'user', content: 'Return ONLY the following XML structure, with no other text or explanation: <response><message>Hello from XML</message></response>. PLEASE WRITE YOUR OUTPUT IN XML FORMAT.' }
        ];
        const response = await client.generate(messages, {mode: 'xml', model});

        expect(response).toBeDefined();
        expect(response.text).not.toBeNull();
        // XML parsing correctness depends on the model actually returning valid XML
        // and the parser handling it. We check if 'data' is populated.
        expect(response.data).toBeDefined(); 
        if (response.data && !response.data.error) {
             // If parsing was successful, we expect an object
            expect(typeof response.data).toBe('object');
            // A simple check, this would need to be more robust based on expected XML structure
            if (typeof response.data.response === 'object' && response.data.response !== null) {
                const responseField = response.data.response as JsonObject; // Cast to JsonObject
                expect(responseField.message).toBe('Hello from XML');
            }
        } else if (response.data?.error) {
            console.warn("XML mode - Model did not return valid XML or parsing failed:", response.data.error);
        }
        console.log("XML mode response data:", response.data);
        console.log("XML mode response text:", response.text);
    }, 30000);

    test('should generate a response for a message with an image attachment', async () => {
        const messages: LLMUserMessage[] = [
            { 
                role: 'user', 
                content: 'What is in this image? Describe it briefly.',
                attachments: [{ type: 'image', url: testImageUrl }]
            }
        ];
        const response = await client.generate(messages, {mode: 'text', model});

        expect(response).toBeDefined();
        expect(response.text).not.toBeNull();
        expect(typeof response.text).toBe('string');
        expect(response.text!.length).toBeGreaterThan(0);
        console.log("Image attachment response:", response.text);
        // Add more specific assertions if you know what to expect from the image.
        // For a random image, a general check that text is returned is a good start.
    }, 45000); // Longer timeout for vision model

    test('should handle a simple tool call workflow', async () => {
        const toolClient = new OpenAIProvider({
            apiKey,
            tools: [{
                    name: 'getCurrentWeather',
                    description: 'Get the current weather in a given location',
                    parameters: {
                        type: 'object',
                        properties: {
                            location: {
                                type: 'string',
                                description: 'The city and state, e.g. San Francisco, CA'
                            },
                            unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
                        },
                        required: ['location']
                    }
            }],
        });

        const initialMessages: LLMUserMessage[] = [
            { role: 'user', content: `What is the weather like in London?
Please use Celsius.` }
        ];
        
        console.log("Tool Call Test - Step 1: Initial request");
        const response1 = await toolClient.generate(initialMessages, {mode: 'text', model});

        expect(response1).toBeDefined();
        expect(response1.text).toBeNull(); // Usually null when a tool call is made
        expect(response1.toolCalls).toBeDefined();
        expect(response1.toolCalls!.length).toBeGreaterThan(0);
        
        const toolCall = response1.toolCalls![0];
        expect(toolCall.name).toBe('getCurrentWeather');
        expect(toolCall.args.location).toContain('London'); // OpenAI might add more details to location
        expect(toolCall.args.unit).toBe('celsius'); // Check if unit preference was picked up
        console.log("Tool Call Test - Step 1 Response (Tool Call):", JSON.stringify(toolCall, null, 2));

        const toolResponseMessage: LLMToolMessage = {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ temperature: '15', unit: 'celsius', description: 'Cloudy' })
        };

        const messagesForStep2: (LLMUserMessage | LLMAssistantMessage | LLMToolMessage)[] = [
            ...initialMessages,
            { // Assistant message that initiated the tool call
                role: 'assistant',
                content: response1.text || "", // content might be null
                tool_calls: response1.toolCalls
            },
            toolResponseMessage
        ];
        
        console.log("Tool Call Test - Step 2: Request with tool response");
        const response2 = await toolClient.generate(messagesForStep2, {mode: 'text', model});

        expect(response2).toBeDefined();
        expect(response2.text).not.toBeNull();
        expect(typeof response2.text).toBe('string');
        expect(response2.text!.toLowerCase()).toContain('london');
        expect(response2.text!).toContain('15');
        // Make the Celsius check more flexible, allowing for symbols like °C or the word celsius
        expect(response2.text!.toLowerCase()).toMatch(/celsius|°c/);
        expect(response2.text!.toLowerCase()).toContain('cloudy');
        expect(response2.toolCalls).toBeUndefined(); // Should not be another tool call
        console.log("Tool Call Test - Step 2 Response (Final Answer):", response2.text);
    }, 60000); // Longer timeout for multi-step process

    test('should handle multiple tool call requests from AI', async () => {
        const multiToolClient = new OpenAIProvider({
            apiKey,
            tools: [
                {
                    name: 'getCurrentWeather',
                    description: 'Get the current weather in a given location',
                    parameters: {
                        type: 'object',
                        properties: {
                            location: { type: 'string', description: 'The city and state, e.g. San Francisco, CA' },
                            unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
                        },
                        required: ['location']
                    }
                },
                {
                    name: 'getStockPrice',
                    description: 'Get the current stock price for a given symbol',
                    parameters: {
                        type: 'object',
                        properties: {
                            symbol: { type: 'string', description: 'The stock symbol, e.g. AAPL' }
                        },
                        required: ['symbol']
                    }
                }
            ]
        });

        const initialMessages: LLMUserMessage[] = [
            { role: 'user', content: 'What is the weather in Paris (Celsius) and what is the stock price for GOOG?' }
        ];

        console.log("Multi-Tool Call Test - Step 1: Initial request");
        const response1 = await multiToolClient.generate(initialMessages, {mode: 'text', model});

        expect(response1).toBeDefined();
        expect(response1.text).toBeNull();
        expect(response1.toolCalls).toBeDefined();
        expect(response1.toolCalls!.length).toBe(2); // Expecting two tool calls

        const weatherToolCall = response1.toolCalls!.find(tc => tc.name === 'getCurrentWeather');
        const stockToolCall = response1.toolCalls!.find(tc => tc.name === 'getStockPrice');

        expect(weatherToolCall).toBeDefined();
        expect(weatherToolCall!.args.location).toContain('Paris');
        expect(weatherToolCall!.args.unit).toBe('celsius');
        console.log("Multi-Tool Call Test - Weather Call:", JSON.stringify(weatherToolCall, null, 2));

        expect(stockToolCall).toBeDefined();
        expect(stockToolCall!.args.symbol).toBe('GOOG');
        console.log("Multi-Tool Call Test - Stock Call:", JSON.stringify(stockToolCall, null, 2));

        const toolResponses: LLMToolMessage[] = [
            {
                role: 'tool',
                tool_call_id: weatherToolCall!.id,
                content: JSON.stringify({ temperature: '18', unit: 'celsius', description: 'Sunny' })
            },
            {
                role: 'tool',
                tool_call_id: stockToolCall!.id,
                content: JSON.stringify({ symbol: 'GOOG', price: '175.50', currency: 'USD' })
            }
        ];

        const messagesForStep2: (LLMUserMessage | LLMAssistantMessage | LLMToolMessage)[] = [
            ...initialMessages,
            { 
                role: 'assistant',
                content: response1.text || "", // Use empty string if content is null to match LLMAssistantMessage type
                tool_calls: response1.toolCalls
            },
            ...toolResponses
        ];
        
        console.log("Multi-Tool Call Test - Step 2: Request with tool responses");
        const response2 = await multiToolClient.generate(messagesForStep2, {mode: 'text', model});

        expect(response2).toBeDefined();
        expect(response2.text).not.toBeNull();
        expect(typeof response2.text).toBe('string');
        expect(response2.text!.toLowerCase()).toContain('paris');
        expect(response2.text!).toContain('18');
        expect(response2.text!.toLowerCase()).toMatch(/celsius|°c/);
        expect(response2.text!.toLowerCase()).toContain('sunny');
        expect(response2.text!.toLowerCase()).toContain('goog');
        expect(response2.text!).toContain('175.50');
        expect(response2.toolCalls).toBeUndefined();
        console.log("Multi-Tool Call Test - Step 2 Response (Final Answer):", response2.text);
    }, 75000); // Longer timeout for multi-step, multi-tool process

});
