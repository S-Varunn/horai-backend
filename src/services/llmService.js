/**
 * @file llmService.js
 * @description LLM Service supporting Google Gemini, OpenAI, Ollama, and a fully autonomous
 * Smart Rule-Based Context Engine when LLM APIs are throttled/offline.
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
    signal: AbortSignal.timeout(10000),
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
    signal: AbortSignal.timeout(10000),
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
 * Fallback intent parser & context engine when no external LLM is available or rate limited
 */
function fallbackRuleBasedParser({ messages }) {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');

  // If a tool has already executed, format its data into a clean, complete response
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
        content: `🎫 **Event Details & Join Code for ${toolResult.event_title || toolResult.title || 'Event'}:**\n• **Event Code / ID:** \`${toolResult.event_id || toolResult.join_code || toolResult.id}\`\n• **Join Link:** ${toolResult.join_link}\n\n*Share this code or link with collaborators so they can view the event and request to join!*`,
        tool_calls: [],
      };
    }
    if (toolResult.invite_url) {
      return {
        content: `🏢 **Organization Invite Link for ${toolResult.organization_name || 'your organization'}:**\n${toolResult.invite_url}\n\n*Share this link with new collaborators to join your organization!*`,
        tool_calls: [],
      };
    }
    // Event Details (get_event_details or get_event_full_context)
    if (toolResult.title && toolResult.hourly_rate !== undefined) {
      const collabs = toolResult.collaborators || toolResult.roster || [];
      const collabsList =
        collabs.length > 0
          ? collabs
              .map(
                (c) =>
                  `• **${c.name}** (${c.email || 'collaborator'}) — ${
                    c.hours_logged ? `${c.hours_logged} hrs logged` : 'Member'
                  }`
              )
              .join('\n')
          : '• *No collaborators joined yet.*';

      return {
        content:
          `✅ 👥 **Team & Event Details for "${toolResult.title}":**\n` +
          `• **Event Lead:** ${toolResult.lead ? toolResult.lead.name : 'Unassigned'}\n` +
          `• **Hourly Rate:** $${parseFloat(toolResult.hourly_rate).toFixed(2)}/hr\n` +
          `• **Date:** ${toolResult.event_date || 'No date set'}\n` +
          `• **Status:** ${toolResult.status || 'open'}\n\n` +
          `**Collaborator Roster (${collabs.length}):**\n${collabsList}\n\n` +
          (toolResult.join_link ? `🎫 **Join Link:** ${toolResult.join_link}` : ''),
        tool_calls: [],
      };
    }
    // Collaborator / Member list (list_collaborators)
    if (toolResult.members) {
      if (toolResult.members.length === 0) {
        return {
          content: `👥 **${toolResult.organization || 'Your organization'}** has no other collaborators yet.\nUse *"I want to invite collaborators"* to generate a join link!`,
          tool_calls: [],
        };
      }
      const list = toolResult.members
        .map(
          (m) =>
            `• **${m.name}** (${m.email}) — ${
              m.is_owner || m.role === 'organizer' ? '👑 Owner / Organizer' : '👤 Collaborator'
            }`
        )
        .join('\n');
      return {
        content: `👥 **Team & Collaborators for "${toolResult.organization || 'Organization'}":**\n\n${list}\n\n*Total Members: ${
          toolResult.count || toolResult.members.length
        }*`,
        tool_calls: [],
      };
    }
    // Collaborator Stats / Personal Earnings (get_collaborator_stats or get_collaborator_timesheet)
    if (
      toolResult.collaborator &&
      (toolResult.total_hours !== undefined || toolResult.total_earnings !== undefined || toolResult.grand_total !== undefined)
    ) {
      const events = (toolResult.events || toolResult.timesheets || [])
        .map(
          (e) =>
            `• **${e.event_title || e.title}**: ${e.hours_worked || e.hours || 0} hrs @ $${
              e.hourly_rate || 0
            }/hr = **$${e.total_owed || e.pay || '0.00'}**`
        )
        .join('\n');
      const grandTotal =
        toolResult.grand_total !== undefined
          ? toolResult.grand_total
          : toolResult.total_earnings || toolResult.total_pay || '0.00';
      return {
        content:
          `📊 **Timesheet & Earnings Summary for ${toolResult.collaborator}:**\n\n` +
          `• **Total Hours Logged:** ${toolResult.total_hours || 0} hrs\n` +
          `• **Total Base Pay:** $${toolResult.total_base_pay || toolResult.total_earnings || '0.00'}\n` +
          (toolResult.total_tips ? `• **Total Tips:** $${toolResult.total_tips}\n` : '') +
          `• **Grand Total Payout:** **$${grandTotal}**\n\n` +
          (events ? `**Event Breakdown:**\n${events}` : ''),
        tool_calls: [],
      };
    }
    // Events List (list_events)
    if (toolResult.events) {
      if (toolResult.events.length === 0) return { content: '📅 You have no events listed.', tool_calls: [] };
      const list = toolResult.events
        .map(
          (e) =>
            `• **${e.title}** (${e.event_date || 'No date'}) — *${e.status || 'open'}* @ **$${parseFloat(
              e.hourly_rate || 0
            ).toFixed(2)}/hr** (${e.collaborator_count || 0} members)`
        )
        .join('\n');
      return { content: `📅 **Organization Events:**\n\n${list}`, tool_calls: [] };
    }
    // Payroll Summary (get_payroll_summary)
    if (toolResult.grand_total !== undefined && toolResult.collaborators) {
      const collabs = (toolResult.collaborators || [])
        .map(
          (c) =>
            `• **${c.name}**: ${c.hours_worked || 0}h worked | Base: $${c.base_pay || 0} | Total: **$${c.total_owed || 0}**`
        )
        .join('\n');
      return {
        content:
          `💰 **Payroll Summary for ${toolResult.event_title || 'Organization'}:**\n` +
          (toolResult.hourly_rate ? `Rate: $${toolResult.hourly_rate}/hr | Date: ${toolResult.event_date || 'N/A'}\n\n` : '\n') +
          `${collabs}\n\n🏆 **Grand Total Payout: $${toolResult.grand_total}**`,
        tool_calls: [],
      };
    }
    // Organization Overview (get_organization_overview)
    if (toolResult.organization && (toolResult.active_events || toolResult.total_members)) {
      const eventsList = (toolResult.active_events || [])
        .map((e) => `• **${e.title}** (${e.event_date || 'No date'}) @ $${e.hourly_rate}/hr`)
        .join('\n');
      return {
        content:
          `🏢 **Overview for "${toolResult.organization.name || toolResult.organization}":**\n` +
          `• **Total Members:** ${toolResult.total_members || 0}\n` +
          `• **Total Active Events:** ${(toolResult.active_events || []).length}\n\n` +
          (eventsList ? `**Upcoming Events:**\n${eventsList}` : ''),
        tool_calls: [],
      };
    }

    return { content: `✅ Request processed successfully.`, tool_calls: [] };
  }

  const rawText = (lastUserMsg?.content || '').trim();
  const text = rawText.toLowerCase();

  // 1. Specific Event Member/Roster Query: "Who are the members of Arangettram?"
  const eventMembersMatch = rawText.match(
    /(?:who\s+(?:is|are)\s+(?:the\s+)?(?:members|team|collaborators|working)\s+(?:of|on|in|for)|show\s+(?:the\s+)?(?:members|team|roster|collaborators)\s+(?:of|for|on)|(?:members|team|roster|collaborators)\s+(?:of|for|on))\s+(?:the\s+)?(?:event\s+)?(["']?[a-zA-Z0-9\s_-]+?["']?)(?:\s+event)?(?:\?)?$/i
  );
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

  // 2. Generic Member / Collaborators / Team Query:
  // "Who are the members?", "Who are all the collaborators?", "Who are working with me?", "Show members", "Team members"
  if (
    /(?:who\s+(?:are|is)\s+(?:all\s+)?(?:the\s+)?(?:collaborators|members|team|people|working)|who\s+(?:is|are)\s+working\s+(?:with\s+me|today|on\s+events)|show\s+(?:all\s+)?(?:the\s+)?(?:members|collaborators|team|roster)|list\s+(?:all\s+)?(?:the\s+)?(?:members|collaborators|team)|who\s+all\s+are\s+the\s+members|who\s+are\s+all\s+the\s+collaborators|members\b|collaborators\b)/i.test(
      text
    )
  ) {
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

  // 3. Personal Pay / Earnings / Hours Query:
  // "How much am I getting paid?", "How much am I making?", "What is my pay?", "Show my hours", "My earnings"
  if (
    /(?:how\s+much\s+(?:am\s+i|do\s+i|will\s+i|can\s+i)\s+(?:getting\s+)?(?:paid|make|earning|owed|getting)|what\s+(?:is|are)\s+my\s+(?:pay|rate|hours|earnings|timesheet|wage)|show\s+my\s+(?:hours|pay|earnings|timesheet|rate)|my\s+(?:hours|pay|earnings|timesheet|rate)|how\s+many\s+hours\s+did\s+i\s+work)/i.test(
      text
    )
  ) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_my_stats',
          type: 'function',
          function: {
            name: 'get_collaborator_timesheet',
            arguments: JSON.stringify({ collaborator_name_or_email: 'me' }),
          },
        },
      ],
    };
  }

  // 4. Rate inquiry for a specific event: "Whats the rate for Arangettram?"
  const rateInquiryMatch = rawText.match(
    /(?:what\s+is\s+(?:the\s+)?|whats\s+(?:the\s+)?|how\s+much\s+is\s+(?:the\s+)?|show\s+(?:the\s+)?|check\s+(?:the\s+)?)?(?:rate|hourly\s+rate|rate\s+per\s+hour|pay\s+rate)\s+(?:for|of|on)\s+(?:the\s+)?(?:event\s+)?(["']?[a-zA-Z0-9\s_-]+?["']?)(?:\s+event)?(?:\?)?$/i
  );
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

  // 5. Collaborator Specific Event Timesheet query: "How much do I need to pay Sarah for Arangettram?"
  const collabTimeMatch = rawText.match(
    /(?:show\s+time\s+(?:that\s+)?|how\s+much\s+(?:time\s+did\s+|do\s+i\s+(?:need\s+to\s+)?pay\s+|should\s+i\s+pay\s+|to\s+pay\s+|is\s+owed\s+to\s+|payout\s+for\s+)|show\s+hours\s+for\s+|timesheet\s+for\s+|payout\s+for\s+)(["']?[a-zA-Z0-9\s_@.-]+?["']?)\s+(?:worked\s+(?:for|on|at)\s+(?:the\s+)?(?:event\s+)?|work\s+on\s+(?:the\s+)?(?:event\s+)?|on\s+(?:the\s+)?(?:event\s+)?|for\s+(?:the\s+)?(?:event\s+)?)(["']?[a-zA-Z0-9\s_-]+?["']?)(?:\s+event)?(?:\?)?$/i
  );
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

  // 6. Collaborator Org-Wide Payout query: "How much do I owe Sarah?" / "What do I owe Sarah?"
  const orgWideOweMatch = rawText.match(
    /(?:how\s+much\s+(?:do\s+i\s+owe|is\s+owed\s+to|should\s+i\s+pay)|what\s+do\s+i\s+owe|total\s+owed\s+to|total\s+payout\s+for)\s+(["']?[a-zA-Z0-9\s_@.-]+?["']?)(?:\?)?$/i
  );
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

  // 6b. Person's Pay/Earnings query: "What is my friend Tharun Kumar's pay?", "What is Tharun's pay?", "What is Sarah's rate?"
  const someonePayMatch = rawText.match(
    /(?:what\s+(?:is|are)|how\s+much\s+(?:is|does|will|gets)|show|check|get)\s+(?:my\s+(?:friend|colleague|coworker|member)\s+)?(["']?[a-zA-Z0-9\s_@.-]+?["']?)(?:'s|’s|\s+is|\s+will\s+be|\s+gets)?\s+(?:pay|rate|hours|earnings|timesheet|wage|payout|compensation)(?:\?)?$/i
  );
  if (someonePayMatch) {
    const rawTarget = someonePayMatch[1].replace(/["']/g, '').trim();
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_someone_pay',
          type: 'function',
          function: {
            name: 'get_collaborator_timesheet',
            arguments: JSON.stringify({ collaborator_name_or_email: rawTarget }),
          },
        },
      ],
    };
  }

  // 7. Overall Payroll Summary / What do I owe everyone:
  if (
    /(?:how\s+much\s+(?:do\s+i|should\s+i|to)\s+owe(?:\s+everyone|\s+all|\s+people)?|what\s+do\s+i\s+owe(?:\s+everyone|\s+all)?|payroll\s+summary|total\s+payroll|total\s+owed\s+across|payouts\s+summary|how\s+much\s+money\s+do\s+i\s+owe)/i.test(
      text
    )
  ) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_payroll_summary',
          type: 'function',
          function: { name: 'get_payroll_summary', arguments: '{}' },
        },
      ],
    };
  }

  // 8. List Events Query: "What events do we have?", "List events", "Show events"
  if (
    /(?:what\s+events\s+(?:do\s+we\s+have|are\s+there|exist)|list\s+events?|show\s+events?|my\s+events?|all\s+events?|what\s+are\s+the\s+events|events\b)/i.test(
      text
    )
  ) {
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

  // 9. Event code / join code / join link / invite link for an event:
  const eventCodeMatch = text.match(
    /(?:(?:give\s+me|get|what\s+is|show)\s+(?:the\s+)?)?(?:join\s+code|event\s+code|code|join\s+link|share\s+link|request\s+link|invite\s+collaborators|link)\s+(?:for|to|of|on)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+?)(?:\s+event)?$/i
  );
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

  // 10. Rate update: "change rate for Gala to $35/hr" / "set rate for Gala to 40"
  const rateUpdateMatch = text.match(
    /(?:change|update|set)\s+(?:the\s+)?(?:rate|hourly\s+rate|pay)\s+(?:for|of|on)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+?)\s+to\s+\$?(\d+(?:\.\d+)?)(?:\s*(?:\/hr|\/hour|per\s+hour|dollars?))?/i
  );
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

  // 11. Assign Event Lead: "set Sarah as lead for Gala"
  const leadAssignMatch = text.match(
    /(?:set|assign|appoint)\s+([a-zA-Z0-9\s_@.-]+?)\s+as\s+(?:the\s+)?(?:event\s+)?lead\s+(?:for|on|of|to)\s+(?:the\s+)?([a-zA-Z0-9\s_-]+)/i
  );
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

  // 12. Create event: "create event [name] on [date] at $[rate]"
  const createMatch = text.match(
    /create\s+event\s+([a-zA-Z0-9\s_-]+?)(?:\s+(?:on|for|at)\s+(\d{4}-\d{2}-\d{2}|today|tomorrow|\w+\s+\d+))?(?:\s+(?:at|for|rate)\s+\$?(\d+(?:\.\d{2})?))?$/i
  );
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

  // 13. Start session / timer: "start session for [event]"
  const startMatch = text.match(/start\s+(?:session|timer)\s+(?:for\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (startMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_start_session',
          type: 'function',
          function: {
            name: 'start_timer',
            arguments: JSON.stringify({ event_identifier: startMatch[1].trim() }),
          },
        },
      ],
    };
  }

  // 14. Stop session / timer: "stop session for [event]"
  const stopMatch = text.match(/stop\s+(?:session|timer)\s+(?:for\s+)?([a-zA-Z0-9\s_-]+)/i);
  if (stopMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_stop_session',
          type: 'function',
          function: {
            name: 'stop_timer',
            arguments: JSON.stringify({ event_identifier: stopMatch[1].trim() }),
          },
        },
      ],
    };
  }

  // 15. Manual hours logging: "log 4.5 hours on Gala for Sarah"
  const logMatch = text.match(
    /(?:log|add|record)\s+(\d+(?:\.\d+)?)\s+(?:hours?|hrs?)\s+(?:on|for)\s+([a-zA-Z0-9\s_-]+?)(?:\s+(?:for|to)\s+([a-zA-Z0-9\s_@.-]+))?$/i
  );
  if (logMatch) {
    return {
      content: '',
      tool_calls: [
        {
          id: 'call_fallback_log_hours',
          type: 'function',
          function: {
            name: 'log_manual_time',
            arguments: JSON.stringify({
              hours: parseFloat(logMatch[1]),
              event_identifier: logMatch[2].trim(),
              collaborator_name_or_email: logMatch[3] ? logMatch[3].trim() : undefined,
            }),
          },
        },
      ],
    };
  }

  // 16. Join requests query: "join requests for Gala"
  const reqMatch = text.match(/(?:show|list|get|view)?\s*(?:pending\s+)?join\s+requests\s+(?:for\s+)?([a-zA-Z0-9\s_-]+)/i);
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

  // 17. General Overview fallback for general questions / greetings:
  return {
    content: '',
    tool_calls: [
      {
        id: 'call_fallback_overview',
        type: 'function',
        function: {
          name: 'get_organization_overview',
          arguments: '{}',
        },
      },
    ],
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
        model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
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

  // 4. Built-in Smart Intent & Context Engine
  return fallbackRuleBasedParser({ messages, tools });
}

module.exports = {
  chatCompletion,
};
