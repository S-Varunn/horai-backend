/**
 * @file agentService.js
 * @description Core Orchestrator for Horai AI Assistant (Discord, WhatsApp & Web)
 * Handles autonomous tool calling, full context retrieval, and confirmation workflows.
 */

const { AGENT_TOOLS } = require('./agent/tools');
const { setPendingAction, getPendingAction, clearPendingAction } = require('./agent/confirmation');
const { getUserDefaultOrg, isOrgHead, resolveEvent, resolveUserInOrg } = require('./agent/resolvers');
const { chatCompletion } = require('./llmService');

// Domain Handlers
const orgHandlers = require('./agent/handlers/orgHandlers');
const eventHandlers = require('./agent/handlers/eventHandlers');
const timeHandlers = require('./agent/handlers/timeHandlers');
const expenseHandlers = require('./agent/handlers/expenseHandlers');
const payrollHandlers = require('./agent/handlers/payrollHandlers');

/**
 * Unified Tool Dispatch Registry
 */
const TOOL_DISPATCH = {
  ...orgHandlers,
  ...eventHandlers,
  ...timeHandlers,
  ...expenseHandlers,
  ...payrollHandlers,
};

/**
 * Execute a tool by name with user and organization context.
 *
 * @param {string} toolName - Name of the tool to execute
 * @param {object} args - Arguments passed by the LLM
 * @param {object} user - Current user object
 * @param {object} org - Current organization object
 * @param {boolean} [skipConfirmation=false] - Whether confirmation was already granted
 * @returns {Promise<object>} Tool execution result
 */
async function executeTool(toolName, args, user, org, skipConfirmation = false) {
  if (!org) {
    return { error: 'No organization found for your user account. Please create or join an organization first.' };
  }

  // Check for Typo Disambiguation ("Did you mean X?") if confirmation hasn't been bypassed
  if (!skipConfirmation && args) {
    if (args.event_identifier && typeof args.event_identifier === 'string') {
      const isSpecial = /^(all|everyone|org|organization|total|overall)$/i.test(args.event_identifier.trim());
      if (!isSpecial) {
        const resolved = await resolveEvent(org.id, args.event_identifier);
        if (resolved && !resolved.isExact && resolved.distance >= 1) {
          setPendingAction(user.id, {
            toolName,
            args: { ...args, event_identifier: resolved.event.title },
            user,
            org,
          });
          return {
            requires_confirmation: true,
            message: `❓ Did you mean **"${resolved.event.title}"**?\n\nReply **"YES"** to proceed or specify the correct event name.`,
          };
        }
      }
    }

    if (args.collaborator_name_or_email && typeof args.collaborator_name_or_email === 'string') {
      const isSpecial = /^(everyone|everybody|all|all\s+members|team|total|overall)$/i.test(args.collaborator_name_or_email.trim());
      if (!isSpecial) {
        const resolved = await resolveUserInOrg(org.id, args.collaborator_name_or_email);
        if (resolved && !resolved.isExact && resolved.distance >= 1) {
          setPendingAction(user.id, {
            toolName,
            args: { ...args, collaborator_name_or_email: resolved.user.name },
            user,
            org,
          });
          return {
            requires_confirmation: true,
            message: `❓ Did you mean **"${resolved.user.name}"**?\n\nReply **"YES"** to proceed or specify the correct name.`,
          };
        }
      }
    }
  }

  const handler = TOOL_DISPATCH[toolName];
  if (!handler) {
    return { error: `Unknown tool: ${toolName}` };
  }

  try {
    return await handler(args, { user, org, skipConfirmation });
  } catch (err) {
    console.error(`[AgentService] Error executing tool "${toolName}":`, err);
    return { error: `Failed to execute ${toolName}: ${err.message}` };
  }
}

/**
 * Build system prompt for the AI Agent with localized user context.
 */
function buildSystemPrompt(user, org, isHead) {
  const orgName = org ? org.name : 'No active organization';
  const orgId = org ? org.id : 'none';
  const today = new Date().toISOString().split('T')[0];

  return `You are Horai Assistant, an intelligent and autonomous AI agent for Horai.
You help users manage organizations, events, live timers, manual hours, driving/material expenses, tips, and payroll summaries.

Current User:
- Name: ${user.name}
- Email: ${user.email}
- Role: ${user.role || 'organizer'}
- Is Head of Organization: ${isHead ? 'YES (Full organizer privileges)' : 'NO (Collaborator)'}
- Active Organization: ${orgName} (ID: ${orgId})
- Today's Date: ${today}

Core Agent Capabilities:
1. Full Context Retrieval: Whenever the user asks ANY question about an event, hours, people, expenses, pay, or timesheets (e.g. "How much do I need to pay X?", "Who worked the most?", "Show details for Y", "What is owed?"), call 'get_event_full_context' or 'get_organization_overview' to retrieve the complete data snapshot, then answer intelligently.
2. Modifications & Updates: When asked to modify or update any details (Event date, rate, lead, time entries, expenses, tips, org name), call the appropriate update tool. The tool will automatically prepare a diff preview and request confirmation from the user.
3. Event Creation: Only the Head of the Organization (is_head: YES) has permission to create events.
4. Keep responses concise, clear, and formatted with clean markdown bullets, dollar amounts, and emojis.`;
}

/**
 * Process an incoming natural language message from a user (Discord, WhatsApp, or Web).
 *
 * @param {object} params
 * @param {object} params.user - Current user object
 * @param {string} params.message - Raw text message from the user
 * @param {Array<object>} [params.history=[]] - Previous conversation messages
 * @returns {Promise<{ reply: string, tools_used: Array<object> }>}
 */
async function processAgentMessage({ user, message, history = [] }) {
  const org = await getUserDefaultOrg(user.id);
  const isHead = isOrgHead(user, org);

  // 1. Check for Pending Confirmation Responses (YES / NO / CONFIRM / CANCEL)
  const trimmed = (message || '').trim().toLowerCase();
  const isConfirm = /^(yes|confirm|proceed|ok|apply|do it|yep|yeah|y|sure)$/i.test(trimmed);
  const isCancel = /^(no|cancel|stop|nevermind|don't|abort|n)$/i.test(trimmed);

  const pending = getPendingAction(user.id);

  if (pending) {
    if (isConfirm) {
      clearPendingAction(user.id);
      const result = await executeTool(pending.toolName, pending.args, user, org, true);
      return {
        reply: result.message || '✅ Changes applied successfully.',
        tools_used: [{ tool: pending.toolName, args: pending.args }],
      };
    } else if (isCancel) {
      clearPendingAction(user.id);
      return {
        reply: '❌ Action cancelled. No changes were made.',
        tools_used: [],
      };
    }
  }

  // 2. Build Agent Conversation Context
  const systemPrompt = buildSystemPrompt(user, org, isHead);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-6).map((h) => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.content,
    })),
    { role: 'user', content: message },
  ];

  // 3. Autonomous ReAct Agent Loop
  let iterations = 0;
  const toolsUsed = [];

  while (iterations < 5) {
    iterations++;
    const response = await chatCompletion({ messages, tools: AGENT_TOOLS });

    if (response.tool_calls && response.tool_calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      });

      for (const call of response.tool_calls) {
        const toolName = call.function.name;
        let toolArgs = {};
        try {
          toolArgs = typeof call.function.arguments === 'string'
            ? JSON.parse(call.function.arguments)
            : call.function.arguments;
        } catch {
          toolArgs = {};
        }

        toolsUsed.push({ tool: toolName, args: toolArgs });

        const toolResult = await executeTool(toolName, toolArgs, user, org);

        // If tool requires user confirmation, return the confirmation prompt immediately
        if (toolResult && toolResult.requires_confirmation) {
          return {
            reply: toolResult.message,
            tools_used: toolsUsed,
          };
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: toolName,
          content: JSON.stringify(toolResult),
        });
      }
    } else {
      return {
        reply: response.content || 'I completed your request.',
        tools_used: toolsUsed,
      };
    }
  }

  return {
    reply: '⚠️ I performed the requested operations, but reached the maximum reasoning steps.',
    tools_used: toolsUsed,
  };
}

module.exports = {
  processAgentMessage,
  executeTool,
  AGENT_TOOLS,
  getUserDefaultOrg,
};
