/**
 * LLM Service supporting multiple providers:
 * - Google Gemini (GEMINI_API_KEY)
 * - OpenAI / OpenAI-compatible (OPENAI_API_KEY, OPENAI_BASE_URL)
 * - Ollama / Local (OLLAMA_BASE_URL, OLLAMA_MODEL)
 * - Fallback intent parser when no API key is configured
 */

async function callOpenAICompatible({ baseUrl, apiKey, model, messages, tools }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: model || 'gpt-4o-mini',
    messages,
    temperature: 0.2,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && apiKey !== 'ollama' ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content || '',
    tool_calls: choice?.message?.tool_calls || [],
    rawMessage: choice?.message,
  };
}

async function callGemini({ apiKey, model, messages, tools }) {
  const selectedModel = model || 'gemini-3.6-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;

  // Convert messages to Gemini format
  const contents = [];
  let systemInstruction = null;

  for (const m of messages) {
    if (m.role === 'system') {
      systemInstruction = { parts: [{ text: m.content }] };
    } else if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let parsedArgs = tc.function.arguments;
          if (typeof parsedArgs === 'string') {
            try { parsedArgs = JSON.parse(parsedArgs); } catch (e) { parsedArgs = {}; }
          }
          const callPart = {
            functionCall: {
              name: tc.function.name,
              args: parsedArgs,
            },
          };
          if (tc.thoughtSignature) {
            callPart.thoughtSignature = tc.thoughtSignature;
          }
          parts.push(callPart);
        }
      }
      contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      let parsedResponse = m.content;
      if (typeof parsedResponse === 'string') {
        try { parsedResponse = JSON.parse(parsedResponse); } catch (e) {}
      }
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name,
              response: { output: parsedResponse },
            },
          },
        ],
      });
    }
  }

  // Convert OpenAI tool schemas to Gemini function declarations
  let geminiTools = undefined;
  if (tools && tools.length > 0) {
    geminiTools = [
      {
        function_declarations: tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        })),
      },
    ];
  }

  const payload = {
    contents,
    ...(systemInstruction ? { systemInstruction } : {}),
    ...(geminiTools ? { tools: geminiTools } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(6000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  let textContent = '';
  const tool_calls = [];

  for (const part of parts) {
    if (part.text) textContent += part.text;
    if (part.functionCall) {
      tool_calls.push({
        id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
        thoughtSignature: part.thoughtSignature || undefined,
      });
    }
  }

  return {
    content: textContent,
    tool_calls,
    rawCandidate: candidate,
  };
}

/**
 * Fallback intent parser when no external LLM API key is yet configured
 */
function fallbackRuleBasedParser({ messages }) {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');

  if (toolMsg) {
    let toolResult;
    try {
      toolResult = JSON.parse(toolMsg.content);
    } catch (e) {
      toolResult = toolMsg.content;
    }

    if (toolResult.error) {
      return { content: `⚠️ ${toolResult.error}`, tool_calls: [] };
    }
    if (toolResult.message) {
      return { content: `✅ ${toolResult.message}`, tool_calls: [] };
    }
    if (toolResult.breakdown_text) {
      return { content: toolResult.breakdown_text, tool_calls: [] };
    }
    if (toolResult.join_link || toolResult.join_code) {
      return {
        content: `🎫 **Event Details & Join Code for ${toolResult.event_title || 'Event'}:**\n• **Event Code / ID:** \`${toolResult.event_id || toolResult.join_code}\`\n• **Join Link:** ${toolResult.join_link}\n\n*Share this code or link with collaborators so they can view the event and request to join!*`,
        tool_calls: [],
      };
    }
    if (toolResult.invite_url) {
      return {
        content: `🏢 **Organization Invite Link for ${toolResult.organization_name || 'your organization'}:**\n${toolResult.invite_url}\n\n*Share this link with new collaborators to join your organization!*`,
        tool_calls: [],
      };
    }
    if (toolResult.members) {
      if (toolResult.members.length === 0) {
        return {
          content: `👥 **${toolResult.organization}** has no other collaborators yet.\nUse *"I want to invite collaborators"* to generate a join link!`,
          tool_calls: [],
        };
      }
      const list = toolResult.members.map((m) => `• **${m.name}** (${m.email}) - *${m.role}*`).join('\n');
      return { content: `👥 **Available Members in ${toolResult.organization}:**\n${list}`, tool_calls: [] };
    }
    if (toolResult.events) {
      if (toolResult.events.length === 0) return { content: '📅 You have no events listed.', tool_calls: [] };
      const list = toolResult.events
        .map((e) => `• **${e.title}** (${e.event_date || 'No date'}) - Status: *${e.status}* @ $${e.hourly_rate}/hr`)
        .join('\n');
      return { content: `📅 **Events:**\n${list}`, tool_calls: [] };
    }
    if (toolResult.grand_total !== undefined) {
      const collabs = (toolResult.collaborators || [])
        .map((c) => `• **${c.name}**: ${c.hours_worked}h worked | Base: $${c.base_pay} | Total: **$${c.total_owed}**`)
        .join('\n');
      return {
        content: `💰 **Payroll Summary for ${toolResult.event_title}**\nRate: $${toolResult.hourly_rate}/hr | Date: ${toolResult.event_date}\n\n${collabs}\n\n🏆 **Grand Total Payout: $${toolResult.grand_total}**`,
        tool_calls: [],
      };
    }
    return { content: `Done! Result: ${JSON.stringify(toolResult)}`, tool_calls: [] };
  }

  const rawText = (lastUserMsg?.content || '').trim();
  const text = rawText.toLowerCase();

  // 0. Collaborator Timesheet query: "How much do I need to pay tharun for the event Arangettram?"
  const collabTimeMatch = rawText.match(/(?:show\s+time\s+(?:that\s+)?|how\s+much\s+(?:time\s+did\s+|do\s+i\s+(?:need\s+to\s+)?pay\s+|should\s+i\s+pay\s+|to\s+pay\s+|is\s+owed\s+to\s+|payout\s+for\s+)|show\s+hours\s+for\s+|timesheet\s+for\s+|payout\s+for\s+)(["']?[a-zA-Z0-9\s_@.-]+?["']?)\s+(?:worked\s+(?:for|on|at)\s+(?:the\s+)?(?:event\s+)?|work\s+on\s+(?:the\s+)?(?:event\s+)?|on\s+(?:the\s+)?(?:event\s+)?|for\s+(?:the\s+)?(?:event\s+)?)(["']?[a-zA-Z0-9\s_-]+?["']?)(?:\s+event)?(?:\?)?$/i);
  if (collabTimeMatch) {
    const rawUser = collabTimeMatch[1].replace(/["']/g, '').trim();
    const rawEvent = collabTimeMatch[2].replace(/["']/g, '').trim();
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_collab_timesheet',
          type: 'function',
          function: {
            name: 'get_collaborator_timesheet',
            arguments: JSON.stringify({
              collaborator_name_or_email: rawUser,
              event_identifier: rawEvent,
            }),
          },
        },
      ],
    };
  }

  // 0b. Collaborator Org-Wide Payout query: "How much do I owe tharun?" / "What do I owe tharun?"
  const orgWideOweMatch = rawText.match(/(?:how\s+much\s+(?:do\s+i\s+owe|is\s+owed\s+to|should\s+i\s+pay)|what\s+do\s+i\s+owe|total\s+owed\s+to|total\s+payout\s+for)\s+(["']?[a-zA-Z0-9\s_@.-]+?["']?)(?:\?)?$/i);
  if (orgWideOweMatch) {
    const rawUser = orgWideOweMatch[1].replace(/["']/g, '').trim();
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_org_wide_owed',
          type: 'function',
          function: {
            name: 'get_collaborator_timesheet',
            arguments: JSON.stringify({
              collaborator_name_or_email: rawUser,
            }),
          },
        },
      ],
    };
  }

  // 1. List events
  if (/list\s+events?|show\s+events?|my\s+events?|all\s+events?/i.test(text)) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_list_events',
          type: 'function',
          function: { name: 'list_events', arguments: '{}' },
        },
      ],
    };
  }

  // 2. Event code / join code / join link / invite link for an event:
  const eventCodeMatch = text.match(/(?:(?:give\s+me|get|what\s+is|show)\s+(?:the\s+)?)?(?:join\s+code|event\s+code|code|join\s+link|share\s+link|request\s+link|invite\s+collaborators|link)\s+(?:for|to|of|on)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+?)(?:\s+event)?$/i);
  if (eventCodeMatch) {
    const rawTarget = eventCodeMatch[1].trim();
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_join_link',
          type: 'function',
          function: {
            name: 'get_event_join_link',
            arguments: JSON.stringify({ event_identifier: rawTarget }),
          },
        },
      ],
    };
  }

  // 2b. Rate inquiry: "Whats the rate per hour for event arangetam"
  const rateInquiryMatch = rawText.match(/(?:what\s+is\s+(?:the\s+)?|whats\s+(?:the\s+)?|how\s+much\s+is\s+(?:the\s+)?|show\s+(?:the\s+)?|check\s+(?:the\s+)?)?(?:rate|hourly\s+rate|rate\s+per\s+hour|pay\s+rate)\s+(?:for|of|on)\s+(?:the\s+)?(?:event\s+)?(["']?[a-zA-Z0-9\s_-]+?["']?)(?:\s+event)?(?:\?)?$/i);
  if (rateInquiryMatch) {
    const rawTarget = rateInquiryMatch[1].replace(/["']/g, '').trim();
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_event_rate',
          type: 'function',
          function: {
            name: 'get_event_details',
            arguments: JSON.stringify({ event_identifier: rawTarget }),
          },
        },
      ],
    };
  }

  // 2c. Event members / roster query: "Who are the members of arangettram?"
  const eventMembersMatch = rawText.match(/(?:who\s+(?:is|are)\s+(?:the\s+)?(?:members|team|collaborators|working)\s+(?:of|on|in|for)|show\s+(?:the\s+)?(?:members|team|roster|collaborators)\s+(?:of|for|on)|(?:members|team|roster|collaborators)\s+(?:of|for|on))\s+(?:the\s+)?(?:event\s+)?(["']?[a-zA-Z0-9\s_-]+?["']?)(?:\s+event)?(?:\?)?$/i);
  if (eventMembersMatch) {
    const rawTarget = eventMembersMatch[1].replace(/["']/g, '').trim();
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_event_members',
          type: 'function',
          function: {
            name: 'get_event_details',
            arguments: JSON.stringify({ event_identifier: rawTarget }),
          },
        },
      ],
    };
  }

  // 3. Rate update: "change rate for Gala to $35/hr" / "set rate for Gala to 40"
  const rateUpdateMatch = text.match(/(?:change|update|set)\s+(?:the\s+)?(?:rate|hourly\s+rate|pay)\s+(?:for|of|on)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+?)\s+to\s+\$?(\d+(?:\.\d+)?)(?:\s*(?:\/hr|\/hour|per\s+hour|dollars?))?/i);
  if (rateUpdateMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_update_rate',
          type: 'function',
          function: {
            name: 'update_event',
            arguments: JSON.stringify({
              event_identifier: rateUpdateMatch[1].trim(),
              hourly_rate: parseFloat(rateUpdateMatch[2]),
            }),
          },
        },
      ],
    };
  }

  // 4. Date update: "change date of Gala to 2026-09-01" / "reschedule Gala to next Saturday"
  const dateUpdateMatch = text.match(/(?:change|update|set|reschedule)\s+(?:the\s+)?(?:date)\s+(?:for|of|on)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+?)\s+to\s+([a-zA-Z0-9\s_-]+)/i);
  if (dateUpdateMatch) {
    let dateStr = dateUpdateMatch[2].trim();
    if (dateStr === 'tomorrow') {
      const tom = new Date();
      tom.setDate(tom.getDate() + 1);
      dateStr = tom.toISOString().split('T')[0];
    } else if (dateStr === 'today') {
      dateStr = new Date().toISOString().split('T')[0];
    }
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_update_date',
          type: 'function',
          function: {
            name: 'update_event',
            arguments: JSON.stringify({
              event_identifier: dateUpdateMatch[1].trim(),
              event_date: dateStr,
            }),
          },
        },
      ],
    };
  }

  // 5. Assign Event Lead: "set Sarah as lead for Gala" / "assign Alex as lead on Gala"
  const leadAssignMatch = text.match(/(?:set|assign|appoint)\s+([a-zA-Z0-9\s_@.-]+?)\s+as\s+(?:the\s+)?(?:event\s+)?lead\s+(?:for|on|of|to)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (leadAssignMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_set_lead',
          type: 'function',
          function: {
            name: 'set_event_lead',
            arguments: JSON.stringify({
              collaborator_name_or_email: leadAssignMatch[1].trim(),
              event_identifier: leadAssignMatch[2].trim(),
            }),
          },
        },
      ],
    };
  }

  // 6. Remove Event Lead: "remove lead for Gala" / "unassign lead from Gala"
  const leadRemoveMatch = text.match(/(?:remove|unassign|clear)\s+(?:event\s+)?lead\s+(?:for|from|on|of)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (leadRemoveMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_remove_lead',
          type: 'function',
          function: {
            name: 'remove_event_lead',
            arguments: JSON.stringify({
              event_identifier: leadRemoveMatch[1].trim(),
            }),
          },
        },
      ],
    };
  }

  // 7. Set tip: "set $30 tip for Sarah on Gala" / "give $25 tip to Alex for Gala"
  const tipMatch = text.match(/(?:set|add|give|update)\s+\$?(\d+(?:\.\d+)?)\s+tip\s+(?:for|to)\s+([a-zA-Z0-9\s_@.-]+?)\s+(?:for|on)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (tipMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_set_tip',
          type: 'function',
          function: {
            name: 'set_tip',
            arguments: JSON.stringify({
              tip_amount: parseFloat(tipMatch[1]),
              collaborator_name_or_email: tipMatch[2].trim(),
              event_identifier: tipMatch[3].trim(),
            }),
          },
        },
      ],
    };
  }

  // 8. Remove tip: "remove tip for Sarah on Gala"
  const tipRemoveMatch = text.match(/(?:remove|delete|clear)\s+tip\s+(?:for|from)\s+([a-zA-Z0-9\s_@.-]+?)\s+(?:for|on)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (tipRemoveMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_remove_tip',
          type: 'function',
          function: {
            name: 'remove_tip',
            arguments: JSON.stringify({
              collaborator_name_or_email: tipRemoveMatch[1].trim(),
              event_identifier: tipRemoveMatch[2].trim(),
            }),
          },
        },
      ],
    };
  }

  // 9. Review expense: "approve Sarah's expense on Gala" / "reject Alex's expense on Gala"
  const reviewExpenseMatch = text.match(/(approve|reject)\s+(?:expense\s+(?:for\s+)?)?([a-zA-Z0-9\s_@.-]+?)(?:'s)?\s+expense\s+(?:on|for)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (reviewExpenseMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_review_expense',
          type: 'function',
          function: {
            name: 'review_expense',
            arguments: JSON.stringify({
              decision: reviewExpenseMatch[1].toLowerCase() === 'approve' ? 'approved' : 'rejected',
              collaborator_name_or_email: reviewExpenseMatch[2].trim(),
              event_identifier: reviewExpenseMatch[3].trim(),
            }),
          },
        },
      ],
    };
  }

  // 10. Delete expense: "delete my expense on Gala"
  const deleteExpenseMatch = text.match(/(?:delete|cancel|remove)\s+(?:my\s+)?(?:pending\s+)?expense\s+(?:on|for)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (deleteExpenseMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_delete_expense',
          type: 'function',
          function: {
            name: 'delete_expense',
            arguments: JSON.stringify({
              event_identifier: deleteExpenseMatch[1].trim(),
            }),
          },
        },
      ],
    };
  }

  // 11. Rename organization: "rename organization to Premier Events"
  const renameOrgMatch = rawText.match(/(?:rename|change\s+name\s+of)\s+(?:my\s+)?(?:org|organization)\s+to\s+([a-zA-Z0-9\s_-]+)/i);
  if (renameOrgMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_update_org',
          type: 'function',
          function: {
            name: 'update_organization',
            arguments: JSON.stringify({
              name: renameOrgMatch[1].trim(),
            }),
          },
        },
      ],
    };
  }

  // 12. Remove organization member: "remove member Sarah from organization"
  const removeOrgMemberMatch = text.match(/(?:remove|kick)\s+(?:member\s+)?([a-zA-Z0-9\s_@.-]+?)\s+from\s+(?:the\s+)?(?:org|organization)/i);
  if (removeOrgMemberMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_remove_org_member',
          type: 'function',
          function: {
            name: 'remove_organization_member',
            arguments: JSON.stringify({
              collaborator_name_or_email: removeOrgMemberMatch[1].trim(),
            }),
          },
        },
      ],
    };
  }

  // 13. Create event regex: "create event [name] on [date] at $[rate]"
  const createMatch = text.match(/create\s+event\s+([a-zA-Z0-9\s_-]+?)(?:\s+(?:on|for|at)\s+(\d{4}-\d{2}-\d{2}|today|tomorrow|\w+\s+\d+))?(?:\s+(?:at|for|rate)\s+\$?(\d+(?:\.\d{2})?))?$/i);
  if (createMatch) {
    const title = createMatch[1].trim();
    let dateStr = createMatch[2] ? createMatch[2].trim() : '';
    const rateStr = createMatch[3] ? createMatch[3].trim() : '25.00';

    if (!dateStr || dateStr === 'today') {
      dateStr = new Date().toISOString().split('T')[0];
    } else if (dateStr === 'tomorrow') {
      const tom = new Date();
      tom.setDate(tom.getDate() + 1);
      dateStr = tom.toISOString().split('T')[0];
    }

    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_create_event',
          type: 'function',
          function: {
            name: 'create_event',
            arguments: JSON.stringify({
              title,
              event_date: dateStr,
              hourly_rate: parseFloat(rateStr),
            }),
          },
        },
      ],
    };
  }

  // 14. Start session / timer: "start session for [event]"
  const startMatch = text.match(/start\s+(?:session|timer)\s+(?:for\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (startMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_start_session',
          type: 'function',
          function: {
            name: 'start_session',
            arguments: JSON.stringify({ event_identifier: startMatch[1].trim() }),
          },
        },
      ],
    };
  }

  // 15. Stop session / timer: "stop session for [event]"
  const stopMatch = text.match(/stop\s+(?:session|timer)\s+(?:for\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (stopMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_stop_session',
          type: 'function',
          function: {
            name: 'stop_session',
            arguments: JSON.stringify({ event_identifier: stopMatch[1].trim() }),
          },
        },
      ],
    };
  }

  // 16. Payroll summary: "summary for [event]" or "payroll for [event]"
  const summaryMatch = text.match(/(?:summary|payroll|payout|payroll\s+summary|hours\s+summary)\s+(?:for\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (summaryMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_get_payroll_summary',
          type: 'function',
          function: {
            name: 'get_payroll_summary',
            arguments: JSON.stringify({ event_identifier: summaryMatch[1].trim() }),
          },
        },
      ],
    };
  }

  // 17. List collaborators / team / members
  if (/(?:list\s+(?:of\s+)?(?:all\s+)?(?:my\s+)?(?:team|members|collaborators)|who\s+(?:is|are)\s+(?:in\s+my\s+team|my\s+members|available)|show\s+(?:all\s+)?(?:my\s+)?(?:members|collaborators)|all\s+my\s+members)/i.test(text)) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_list_collabs',
          type: 'function',
          function: { name: 'list_collaborators', arguments: '{}' },
        },
      ],
    };
  }

  // 18. General invite collaborators / invite link
  if (/invite\s+collaborators|generate\s+(?:invite\s+)?link|invite\s+members/i.test(text)) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_org_invite',
          type: 'function',
          function: { name: 'create_organization_invite_link', arguments: '{}' },
        },
      ],
    };
  }

  // 19. Invite specific collaborator: "invite [name] to [event]"
  const inviteMatch = text.match(/invite\s+([a-zA-Z0-9\s_@.-]+?)\s+to\s+([a-zA-Z0-9\s_-]+)/i);
  if (inviteMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_invite',
          type: 'function',
          function: {
            name: 'invite_collaborator_to_event',
            arguments: JSON.stringify({
              collaborator_name_or_email: inviteMatch[1].trim(),
              event_identifier: inviteMatch[2].trim(),
            }),
          },
        },
      ],
    };
  }

  // 20. Join requests: "requests for [event]" or "join requests for [event]"
  const reqMatch = text.match(/(?:join\s+)?requests\s+(?:for\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (reqMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_requests',
          type: 'function',
          function: {
            name: 'list_join_requests',
            arguments: JSON.stringify({ event_identifier: reqMatch[1].trim() }),
          },
        },
      ],
    };
  }

  // 21. Accept / Reject join request: "accept [name] for [event]"
  const reviewMatch = text.match(/(accept|reject)\s+([a-zA-Z0-9\s_@.-]+?)\s+(?:for|to|on)\s+([a-zA-Z0-9\s_-]+)/i);
  if (reviewMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_review_req',
          type: 'function',
          function: {
            name: 'review_join_request',
            arguments: JSON.stringify({
              decision: reviewMatch[1].toLowerCase() === 'accept' ? 'accepted' : 'rejected',
              collaborator_name_or_email: reviewMatch[2].trim(),
              event_identifier: reviewMatch[3].trim(),
            }),
          },
        },
      ],
    };
  }

  // 22. Adjust hours / modify time: "adjust hours for [name] on [event] to [hours]"
  const adjustMatch = text.match(/(?:adjust|modify|update|change)\s+(?:hours|time)\s+(?:for\s+)?([a-zA-Z0-9\s_@.-]+?)\s+(?:on|for)\s+([a-zA-Z0-9\s_-]+?)\s+to\s+(\d+(?:\.\d+)?)/i);
  if (adjustMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_modify_time',
          type: 'function',
          function: {
            name: 'modify_time_entry',
            arguments: JSON.stringify({
              collaborator_name_or_email: adjustMatch[1].trim(),
              event_identifier: adjustMatch[2].trim(),
              new_hours: parseFloat(adjustMatch[3]),
            }),
          },
        },
      ],
    };
  }

  // 23. Delete time entry: "delete time entry for [name] on [event]"
  const deleteTimeMatch = text.match(/(?:delete|remove)\s+(?:time\s+entry|hours)\s+(?:for\s+)?([a-zA-Z0-9\s_@.-]+?)\s+(?:on|for)\s+([a-zA-Z0-9\s_-]+)/i);
  if (deleteTimeMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_delete_time',
          type: 'function',
          function: {
            name: 'delete_time_entry',
            arguments: JSON.stringify({
              collaborator_name_or_email: deleteTimeMatch[1].trim(),
              event_identifier: deleteTimeMatch[2].trim(),
            }),
          },
        },
      ],
    };
  }

  return {
    content: `👋 I received: "${lastUserMsg?.content}".\n\n*Available Commands:*\n• "Show available members in my organization"\n• "Create event Gala on Friday for $30/hr"\n• "Get join link for Gala"\n• "Start session for Gala" / "Stop session for Gala"\n• "Log 4.5 hours on Gala for Sarah"\n• "Payroll summary for Gala"\n• "Join requests for Gala"`,
    tool_calls: [],
  };
}

/**
 * Execute chat completion using the active provider with automatic fallback
 */
async function chatCompletion({ messages, tools }) {
  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();

  // 1. Google Gemini
  if ((provider === 'gemini' || !provider) && process.env.GEMINI_API_KEY) {
    try {
      return await callGemini({
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
        messages,
        tools,
      });
    } catch (e) {
      console.warn('[Gemini LLM Warning]:', e.message);
    }
  }

  // 2. Ollama / Local
  if (provider === 'ollama') {
    try {
      const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
      return await callOpenAICompatible({
        baseUrl,
        apiKey: 'ollama',
        model: process.env.OLLAMA_MODEL || 'llama3',
        messages,
        tools,
      });
    } catch (e) {
      console.warn('[Ollama LLM Warning]:', e.message);
    }
  }

  // 3. OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
      return await callOpenAICompatible({
        baseUrl,
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages,
        tools,
      });
    } catch (e) {
      console.warn('[OpenAI LLM Warning]:', e.message);
    }
  }

  // 4. Built-in Smart Fallback Parser
  return fallbackRuleBasedParser({ messages, tools });
}

module.exports = {
  chatCompletion,
};
