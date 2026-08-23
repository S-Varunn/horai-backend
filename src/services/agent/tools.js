/**
 * @file tools.js
 * @description JSON Schema tool definitions for Horai Assistant (Function Calling API)
 */

const AGENT_TOOLS = [
  // ── Organization Tools ──────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'list_collaborators',
      description: 'List all available members and collaborators currently in the organization with their roles.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_organization',
      description: 'Rename or update organization details (Owner / Organizer only). Asks for confirmation before saving.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'New name for the organization' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_organization_invite_link',
      description: 'Generate a shareable 7-day invite link for new collaborators to join this organization (Organizer only).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revoke_organization_invite_link',
      description: 'Revoke or deactivate an active organization invite link (Organizer only).',
      parameters: {
        type: 'object',
        properties: {
          invite_code: { type: 'string', description: 'The invite code to deactivate' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_organization_member',
      description: 'Remove a collaborator from the organization (Owner / Organizer only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          collaborator_name_or_email: { type: 'string', description: 'Name or email of the member to remove' },
        },
        required: ['collaborator_name_or_email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_organization_overview',
      description: 'Get a complete overview of the organization, all its events, all members and roles, active invite links, and general status.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },

  // ── Event Management Tools ──────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'list_events',
      description: 'List events in the organization. Can filter by status (draft, scheduled, active, completed).',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Filter by event status: draft, scheduled, active, completed' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: 'Create a new event in the organization (Head of Organization / Organizer ONLY). Can optionally assign an Event Lead and invite collaborators.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title or name of the event (e.g. "Summer Wedding Catering")' },
          event_date: { type: 'string', description: 'Date of event in YYYY-MM-DD format (or ISO date string)' },
          hourly_rate: { type: 'number', description: 'Hourly pay rate in USD (e.g. 25.00)' },
          description: { type: 'string', description: 'Optional description or notes about the event' },
          lead_collaborator_name_or_email: { type: 'string', description: 'Optional name or email of collaborator to assign as Event Lead' },
          invitee_names_or_emails: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of collaborator names or emails to invite to this event',
          },
        },
        required: ['title', 'event_date', 'hourly_rate'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_event_details',
      description: 'Get full details of a specific event by title or ID, including the Event Lead, active timers, invitees, and join link.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_event_full_context',
      description: 'Get the complete unified data snapshot of an event (metadata, lead, roster, live timer, manual timesheets, expenses, tips, and full payroll breakdown). Use this to answer ANY analytical or specific question about the event.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_event_join_link',
      description: 'Generate or retrieve the sharable join link and event ID code for a specific event.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_event',
      description: 'Update event metadata such as title, date, hourly rate, description, or status (Event Lead or Organizer only). Asks for confirmation before saving.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Current event title or event ID UUID' },
          title: { type: 'string', description: 'New title for the event' },
          event_date: { type: 'string', description: 'New event date in YYYY-MM-DD format' },
          hourly_rate: { type: 'number', description: 'New hourly pay rate in USD (e.g. 35.00)' },
          description: { type: 'string', description: 'New description' },
          status: { type: 'string', enum: ['draft', 'scheduled', 'active', 'completed'], description: 'New status' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_event_lead',
      description: 'Assign or reassign the Event Lead for an event (Organizer or current Lead only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Name or email of collaborator to assign as Event Lead' },
        },
        required: ['event_identifier', 'collaborator_name_or_email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_event_lead',
      description: 'Remove/unassign the Event Lead from an event (Organizer only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'invite_collaborators_to_event',
      description: 'Invite one or more collaborators from the organization to an event (Event Lead or Organizer only).',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_names_or_emails: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of names or emails of organization members to invite',
          },
        },
        required: ['event_identifier', 'collaborator_names_or_emails'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_collaborator_from_event',
      description: 'Remove a collaborator invitation/roster from an event (Event Lead or Organizer only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Name or email of collaborator to remove' },
        },
        required: ['event_identifier', 'collaborator_name_or_email'],
      },
    },
  },

  // ── Time Tracking & Session Tools ───────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'start_session',
      description: 'Start a live timer/session for an event. Event Lead, Organizer, or Collaborator assigned to the event.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          title: { type: 'string', description: 'Optional session title (e.g. "Morning Shift")' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_session',
      description: 'Stop the active live timer/session for an event.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'log_manual_time',
      description: 'Log manual hours for a collaborator on an event (Event Lead or Organizer only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Collaborator name or email' },
          hours: { type: 'number', description: 'Number of hours worked (e.g. 4.5)' },
          notes: { type: 'string', description: 'Optional notes for this manual entry' },
        },
        required: ['event_identifier', 'collaborator_name_or_email', 'hours'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'modify_time_entry',
      description: 'Modify or adjust hours for an existing collaborator time entry on an event (Event Lead or Organizer only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Collaborator name or email' },
          new_hours: { type: 'number', description: 'Updated total hours worked (e.g. 5.0)' },
          notes: { type: 'string', description: 'Optional updated notes' },
        },
        required: ['event_identifier', 'collaborator_name_or_email', 'new_hours'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_time_entry',
      description: 'Delete/remove a manual time entry for a collaborator on an event (Event Lead or Organizer only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Collaborator name or email' },
        },
        required: ['event_identifier', 'collaborator_name_or_email'],
      },
    },
  },

  // ── Expense Management Tools ────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'submit_expense',
      description: 'Submit an expense for an event (driving travel hours or material purchase).',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          type: { type: 'string', enum: ['driving', 'material', 'other'], description: 'Expense type' },
          amount_usd: { type: 'number', description: 'Amount in USD (required for material/other)' },
          hours_driven: { type: 'number', description: 'Driving hours (required for driving expense)' },
          is_passenger: { type: 'boolean', description: 'True if was a passenger, false if driver' },
          description: { type: 'string', description: 'Description or receipt details' },
        },
        required: ['event_identifier', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_expense',
      description: 'Update details of a pending expense submitted by the user. Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          type: { type: 'string', enum: ['driving', 'material', 'other'], description: 'Expense type' },
          amount_usd: { type: 'number', description: 'Updated amount in USD' },
          hours_driven: { type: 'number', description: 'Updated driving hours' },
          description: { type: 'string', description: 'Updated description' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'review_expense',
      description: 'Approve or reject a collaborator expense for an event (Event Lead or Organizer only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Collaborator who submitted the expense' },
          decision: { type: 'string', enum: ['approved', 'rejected'], description: 'Approval decision' },
        },
        required: ['event_identifier', 'collaborator_name_or_email', 'decision'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_expense',
      description: 'Delete a pending expense on an event. Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Optional collaborator name (if lead/organizer deleting for member)' },
        },
        required: ['event_identifier'],
      },
    },
  },

  // ── Tips & Payroll Tools ────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'set_tip',
      description: 'Set or update a collaborator tip on an event (Event Lead or Organizer only). Asks for confirmation before applying.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Collaborator name or email' },
          tip_amount: { type: 'number', description: 'Tip amount in USD (e.g. 50.00)' },
          notes: { type: 'string', description: 'Optional notes for the tip' },
        },
        required: ['event_identifier', 'collaborator_name_or_email', 'tip_amount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_tip',
      description: 'Remove/clear a collaborator tip on an event (Event Lead or Organizer only). Asks for confirmation.',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
          collaborator_name_or_email: { type: 'string', description: 'Collaborator name or email' },
        },
        required: ['event_identifier', 'collaborator_name_or_email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_payroll_summary',
      description: 'Get full payroll and payout breakdown for an event (hours, base pay, driving pay, tips, grand total).',
      parameters: {
        type: 'object',
        properties: {
          event_identifier: { type: 'string', description: 'Event title or event ID UUID' },
        },
        required: ['event_identifier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_collaborator_timesheet',
      description: 'Show detailed time worked, timesheet entries, expenses, tips, and total payout for a specific collaborator. If event_identifier is omitted, calculates total owed across all events in the organization.',
      parameters: {
        type: 'object',
        properties: {
          collaborator_name_or_email: { type: 'string', description: 'Collaborator name or email (e.g. "Tharun")' },
          event_identifier: { type: 'string', description: 'Optional event title or event ID. If omitted, computes total owed across ALL events in the organization.' },
        },
        required: ['collaborator_name_or_email'],
      },
    },
  },
];

module.exports = { AGENT_TOOLS };
