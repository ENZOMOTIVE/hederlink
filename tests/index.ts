import express from 'express';
import { urlencoded } from 'body-parser';
import twilio from 'twilio';
import * as dotenv from 'dotenv';
import HederaAgentKit from "../src/agent";
import { createHederaTools } from "../src";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";

// Load environment variables
dotenv.config();

// Validate required environment variables
function validateEnvironment(): void {
  const requiredVars = [
    "OPENAI_API_KEY", 
    "HEDERA_ACCOUNT_ID",
    "HEDERA_PRIVATE_KEY",
    "HEDERA_PUBLIC_KEY",
    "HEDERA_NETWORK_TYPE",
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER"
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error("Error: Required environment variables are not set");
    missingVars.forEach(varName => {
      console.error(`${varName}=your_${varName.toLowerCase()}_here`);
    });
    process.exit(1);
  }
}

validateEnvironment();

// Configure Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Initialize Express app
const app = express();
app.use(urlencoded({ extended: false }));

// Global variable to store the agent instance
let agentInstance: any = null;
let agentConfig: any = null;

// User session store to maintain conversation state
const userSessions: Record<string, any> = {};

// Initialize Hedera Agent
async function initializeAgent() {
  try {
    const llm = new ChatOpenAI({
      modelName: "gpt-4o-mini",
    });

    // Initialize HederaAgentKit
    const hederaKit = new HederaAgentKit(
      process.env.HEDERA_ACCOUNT_ID!,
      process.env.HEDERA_PRIVATE_KEY!,
      process.env.HEDERA_PUBLIC_KEY!,
      process.env.HEDERA_NETWORK_TYPE as "testnet" || "testnet"
    );

    // Create the LangChain-compatible tools
    const tools = createHederaTools(hederaKit);

    // Prepare an in-memory checkpoint saver
    const memory = new MemorySaver();

    // Additional configuration for the agent
    const config = { configurable: { thread_id: "Hedera Agent Kit!" } };

    // Create the React agent
    const agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: memory,
      messageModifier: `
        **General Guidelines**
        You are a helpful agent that can interact on-chain using the Hedera Agent Kit. 
        You are empowered to interact on-chain using your tools. If you ever need funds,
        you can request them from a faucet or from the user. 
        If there is a 5XX (internal) HTTP error code, ask the user to try again later. 
        If someone asks you to do something you can't do with your available tools, you 
        must say so, and encourage them to implement it themselves with the Hedera Agent Kit. 
        Keep your responses concise and helpful. You are responding to users via WhatsApp.
        
        **Token Creation Rules**:
        If the user mentions **NFT**, **non-fungible token**, or **unique token**, always use the **hedera_create_non_fungible_token** tool.
        If the user mentions **fungible token**, **FT**, or **decimal-based token**, always use the **hedera_create_fungible_token** tool.
      `,
    });

    return { agent, config };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

// Process a user message with the agent
async function processMessage(userPhoneNumber: string, messageText: string): Promise<string> {
  try {
    if (!agentInstance) {
      const result = await initializeAgent();
      agentInstance = result.agent;
      agentConfig = result.config;
    }
    
    // Get or create user session
    if (!userSessions[userPhoneNumber]) {
      userSessions[userPhoneNumber] = {
        // You can store user-specific data here if needed
        isCustodial: process.env.CUSTODIAL_MODE === "true"
      };
    }
    
    // Process the message through the agent
    const userConfig = {
      ...agentConfig,
      configurable: {
        ...agentConfig.configurable,
        isCustodial: userSessions[userPhoneNumber].isCustodial,
        thread_id: `WhatsApp-${userPhoneNumber}` // Use phone number to maintain separate threads
      }
    };
    
    // Collect all output chunks to form complete response
    let fullResponse = "";
    const stream = await agentInstance.stream(
      { messages: [new HumanMessage(messageText)] },
      userConfig
    );
    
    for await (const chunk of stream) {
      if ("agent" in chunk) {
        fullResponse += chunk.agent.messages[0].content + "\n";
      } else if ("tools" in chunk) {
        fullResponse += chunk.tools.messages[0].content + "\n";
      }
    }
    
    return fullResponse.trim();
  } catch (error) {
    console.error("Error processing message:", error);
    return "Sorry, I encountered an error processing your request. Please try again later.";
  }
}

// Webhook endpoint for receiving WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    // Extract the message details from Twilio's webhook payload
    const incomingMessage = req.body.Body;
    const fromNumber = req.body.From;
    
    // Create a TwiML response
    const twiml = new twilio.twiml.MessagingResponse();
    
    // Process long-running operation and send response asynchronously
    res.writeHead(200, {'Content-Type': 'text/xml'});
    res.end(twiml.toString());
    
    // Process the message with the agent
    const agentResponse = await processMessage(fromNumber, incomingMessage);
    
    // Send the agent's response back via WhatsApp
    await twilioClient.messages.create({
      body: agentResponse,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: fromNumber
    });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error processing webhook');
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('Service is running');
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Initializing Hedera Agent...');
  
  // Pre-initialize the agent
  initializeAgent()
    .then(result => {
      agentInstance = result.agent;
      agentConfig = result.config;
      console.log('Hedera Agent initialized and ready to receive WhatsApp messages');
    })
    .catch(error => {
      console.error('Failed to initialize agent:', error);
    });
});