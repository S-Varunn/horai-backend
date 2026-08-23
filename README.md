# ⏳ Horai — Backend API & AI Bot Service

Modern Node.js + PostgreSQL REST API with native WhatsApp and Discord AI Assistant integrations for **Horai** — the autonomous event operations, time logging, expense management, and payroll platform.

---

## 🚀 Overview

Horai Backend provides the centralized engine for:
* **Event & Session Management**: Real-time collaborative clock-in/out sessions, manual time entries, and retroactive hour adjustments.
* **Expense Tracking & Reimbursements**: Mileage calculations, driver vs passenger rate splits, materials, and organizer approval workflows.
* **Automated Payroll & Tip Engine**: Instant per-collaborator wage breakdowns, travel compensations, tips, and financial audit logs.
* **Native WhatsApp AI Assistant**: Multi-device Baileys gateway supporting prefix filtering (`Horai, ...`), pairing codes, and autonomous tool calling.
* **Official Discord Bot Integration**: Direct slash command and natural language event operations inside Discord guilds.
* **Security & Auth**: Role-based access control (RBAC), bcrypt hashing, JWT Bearer authentication, and optional email 2FA.

---

## 🛠️ Prerequisites

* **Node.js**: 18+ (Node 20+ recommended)
* **PostgreSQL**: 14+
* **npm**: 9+

---

## 📦 Setup & Installation

### Option 1: Automated Script Setup

Run the interactive setup script for your platform:

#### 💻 Windows (PowerShell)
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\setup.ps1
```

#### 🐧 Linux / 🍎 macOS (Bash)
```bash
./setup.sh
```

---

### Option 2: Manual Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Create the PostgreSQL database**:
   ```bash
   psql -U postgres -c "CREATE DATABASE horai_db;"
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and fill in your configuration:
   ```env
   PORT=3000
   NODE_ENV=development
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=horai_db
   DB_USER=postgres
   DB_PASSWORD=your_password
   JWT_SECRET=your_super_secret_jwt_key_here
   GEMINI_API_KEY=your_gemini_api_key
   DISCORD_BOT_TOKEN=your_discord_bot_token
   ```

4. **Run database migrations**:
   ```bash
   npm run migrate
   ```

5. **Start the server**:
   ```bash
   # Development (with nodemon auto-restart)
   npm run dev

   # Production
   npm run start:prod
   ```

   The API will be live at: `http://localhost:3000`

---

## ☁️ Production Deployment & Hosting

### Railway (Recommended)
1. Link repository `S-Varunn/horai-backend`.
2. Add a **PostgreSQL** database service in Railway.
3. Set environment variables (`DATABASE_URL`, `JWT_SECRET`, `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`).
4. Attach a Volume to `/app/data/whatsapp_auth` for WhatsApp session persistence.
5. Deploy! `npm run start:prod` automatically runs Knex migrations on startup.

### Render
1. Create a **Web Service** pointing to `S-Varunn/horai-backend`.
2. Build Command: `npm install`
3. Start Command: `npm run start:prod`
4. Attach a PostgreSQL database and configure `DATABASE_URL`.

### Docker
```bash
docker build -t horai-backend .
docker run -p 3000:3000 --env-file .env horai-backend
```

---

## 📡 API Reference

### 🔐 Authentication (`/api/auth`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | Public | Register new user (`organizer` \| `collaborator`) |
| `POST` | `/api/auth/login` | Public | Login with email/password (returns JWT or triggers 2FA) |
| `POST` | `/api/auth/verify-2fa` | Public | Verify 6-digit email 2FA code |
| `GET` | `/api/auth/me` | User | Get current profile |

### 🏢 Organizations (`/api/orgs`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/orgs` | User | List organizations user belongs to |
| `POST` | `/api/orgs` | Organizer | Create organization |
| `GET` | `/api/orgs/:id` | Member | Get organization details |
| `PATCH` | `/api/orgs/:id` | Owner | Update organization name |
| `DELETE` | `/api/orgs/:id` | Owner | Delete organization and all associated data |
| `GET` | `/api/orgs/:id/members` | Member | List organization members |
| `POST` | `/api/orgs/:id/invite-links`| Owner | Generate 7-day invite link |
| `POST` | `/api/orgs/join/:invite_code` | User | Join organization via invite link |

### 📅 Events (`/api/events`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/orgs/:orgId/events` | Owner | Create new event |
| `GET` | `/api/orgs/:orgId/events` | Member | List events in organization |
| `GET` | `/api/events/:id` | Member | Get event details, collaborators, and sessions |
| `PATCH` | `/api/events/:id` | Owner | Update event details |
| `DELETE` | `/api/events/:id` | Owner | Delete event |
| `POST` | `/api/events/:id/invite` | Owner | Invite collaborators |
| `PATCH` | `/api/events/:id/rsvp` | Invitee | Accept/decline event invite |
| `POST` | `/api/events/:id/complete` | Owner | Mark event complete & finalize payroll |

### ⏱️ Time Tracking (`/api/events/:id/...`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/events/:id/sessions/start` | Lead/Owner | Start live event time session |
| `POST` | `/api/events/:id/sessions/stop` | Lead/Owner | Stop live time session |
| `GET` | `/api/events/:id/sessions` | Member | List recorded sessions |
| `POST` | `/api/events/:id/time` | Accepted | Submit manual time entry |
| `GET` | `/api/events/:id/time` | Member | List manual time entries |
| `DELETE`| `/api/time-entries/:id` | Creator/Owner | Delete manual time entry |

### 💵 Expenses & Payroll (`/api/events/:id/...`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `POST` | `/api/events/:id/expenses` | Accepted | Submit driving, material, or general expense |
| `GET` | `/api/events/:id/expenses` | Member | List event expenses |
| `PATCH` | `/api/expenses/:id/review` | Organizer | Approve or reject expense |
| `PUT` | `/api/events/:id/tips/:userId` | Owner | Set custom tip for collaborator |
| `GET` | `/api/events/:id/summary` | Member | Compute complete payroll breakdown |

### 🤖 Bot Gateways (`/api/whatsapp`, `/api/discord`, `/api/agent`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/whatsapp/status` | User | Get user WhatsApp connection status & pairing code |
| `GET` | `/api/whatsapp/gateway-status` | Owner | Get WhatsApp socket gateway QR code & connection state |
| `POST` | `/api/whatsapp/request-gateway-code` | Owner | Request 8-character phone pairing code |
| `POST` | `/api/whatsapp/unlink` | User | Unlink user WhatsApp account |
| `GET` | `/api/discord/status` | User | Get Discord account connection status & 6-digit code |
| `POST` | `/api/discord/pairing-code` | User | Generate new Discord pairing code |
| `POST` | `/api/discord/unlink` | User | Disconnect Discord account |
| `POST` | `/api/agent/chat` | User | Web AI assistant query & tool execution |

---

## 🧮 Payroll Calculation Formula

For each accepted collaborator on an event:

$$\text{Hours Worked} = \frac{\sum \text{Session Minutes} + \sum \text{Manual Minutes}}{60}$$

$$\text{Base Pay} = \text{Hours Worked} \times \text{Hourly Rate}$$

$$\text{Driving Pay} = (\text{Driver Hours} \times \text{Hourly Rate}) + (\text{Passenger Hours} \times \frac{\text{Hourly Rate}}{2})$$

$$\text{Total Owed} = \text{Base Pay} + \text{Driving Pay} + \text{Approved Expenses} + \text{Tip}$$

---

## 🧪 Testing

Run backend unit tests:
```bash
npm test
```
