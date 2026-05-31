# Timesheet Tracker — Backend

Node.js + PostgreSQL REST API for the Timesheet Tracker app.

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+
- ngrok (for exposing to the internet)

---

## Setup

### Recommended: Quick Automated Setup

You can set up the entire workspace (installing dependencies, creating the database, generating a secure `.env` file, and running database migrations) smoothly with a single interactive command:

```bash
./setup.sh
```

---

### Alternative: Manual Setup

If you prefer to set up the project step-by-step, follow these instructions:

#### 1. Install dependencies

```bash
npm install
```

#### 2. Create the database

```bash
psql -U postgres -c "CREATE DATABASE timesheet_tracker;"
```

#### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your database credentials:

```
DB_HOST=localhost
DB_PORT=5432
DB_NAME=timesheet_tracker
DB_USER=postgres
DB_PASSWORD=your_postgres_password
JWT_SECRET=some_long_random_string_here
```

#### 4. Run migrations

```bash
npm run migrate
```

#### 5. Start the server

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

The API will be live at: `http://localhost:3000`

---

## Exposing via ngrok

```bash
# Install ngrok if needed: https://ngrok.com/download
ngrok http 3000
```

You'll get a URL like `https://abc123.ngrok.io`. Set it in `.env`:

```
BASE_URL=https://abc123.ngrok.io
```

Give this base URL to your Replit frontend. All API calls should go to `BASE_URL/api/...`.

---

## API Reference

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/register` | ❌ | Register (role: organizer \| collaborator) |
| POST | `/api/auth/login` | ❌ | Login → returns JWT |
| GET | `/api/auth/me` | ✅ | Get current user |

### Organizations
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/orgs` | ✅ | List my orgs |
| POST | `/api/orgs` | ✅ Organizer | Create org |
| GET | `/api/orgs/:id` | ✅ Member | Get org details |
| PATCH | `/api/orgs/:id` | ✅ Owner | Rename org |
| GET | `/api/orgs/:id/members` | ✅ Member | List members |
| POST | `/api/orgs/join/:invite_code` | ✅ | Join via invite link |
| POST | `/api/orgs/:id/invite-links` | ✅ Owner | Generate invite link (7-day expiry) |
| GET | `/api/orgs/:id/invite-links` | ✅ Owner | List invite links |
| DELETE | `/api/orgs/:id/invite-links/:linkId` | ✅ Owner | Revoke invite link |

### Events
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/orgs/:orgId/events` | ✅ Owner | Create event |
| GET | `/api/orgs/:orgId/events` | ✅ Member | List events |
| GET | `/api/events/:id` | ✅ Member | Get event + invitees |
| PATCH | `/api/events/:id` | ✅ Owner | Update event |
| PATCH | `/api/events/:id/lead` | ✅ Owner | Set lead collaborator |
| DELETE | `/api/events/:id` | ✅ Owner | Delete event |
| POST | `/api/events/:id/invite` | ✅ Owner | Invite collaborators |
| PATCH | `/api/events/:id/rsvp` | ✅ | Accept/decline invitation |
| POST | `/api/events/:id/complete` | ✅ Owner | Mark event complete (locks data) |

### Time Tracking
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/events/:id/sessions/start` | ✅ Lead | Start session |
| POST | `/api/events/:id/sessions/stop` | ✅ Lead | Stop session (auto-calculates duration) |
| GET | `/api/events/:id/sessions` | ✅ Member | List sessions + totals |
| POST | `/api/events/:id/time` | ✅ Accepted | Add manual time entry |
| GET | `/api/events/:id/time` | ✅ Member | List manual entries |
| DELETE | `/api/time-entries/:id` | ✅ Owner | Delete own manual entry |

### Expenses
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/events/:id/expenses` | ✅ Accepted | Submit expense (driving / material / other) |
| GET | `/api/events/:id/expenses` | ✅ Member | List all expenses |
| DELETE | `/api/expenses/:id` | ✅ Owner | Delete own pending expense |
| PATCH | `/api/expenses/:id/review` | ✅ Organizer | Approve / reject + comment |

### Tips & Payroll Summary
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| PUT | `/api/events/:id/tips/:userId` | ✅ Owner | Set/update tip for a collaborator |
| GET | `/api/events/:id/tips` | ✅ Member | List all tips |
| GET | `/api/events/:id/summary` | ✅ Member | Full payroll breakdown per collaborator |

---

## Payroll Calculation

For each accepted collaborator on an event:

| Component | Formula |
|-----------|---------|
| **Hours worked** | `(session_minutes + manual_minutes) / 60` |
| **Base pay** | `hours_worked × event.hourly_rate` |
| **Driver pay** | `hours_driven × event.hourly_rate` |
| **Passenger pay** | `hours_driven × event.hourly_rate / 2` |
| **Other expenses** | Sum of approved material + other expenses |
| **Tip** | Organizer-set per collaborator |
| **Total owed** | `base + driver + passenger + expenses + tip` |

> Only **approved** expenses are included in totals. The event cannot be marked complete while any expenses are still **pending**.

---

## JWT Authentication

All protected endpoints require:

```
Authorization: Bearer <token>
```

Tokens expire after 7 days (configurable via `JWT_EXPIRES_IN`).
