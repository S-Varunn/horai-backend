#!/usr/bin/env bash

# Horai Backend Smooth Setup Script
# Works on any Linux/macOS environment with Node.js and PostgreSQL

set -e # Exit immediately if a command exits with a non-zero status

# Text colors and styles
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Clear terminal screen for a clean presentation
clear

echo -e "${CYAN}${BOLD}=====================================================${NC}"
echo -e "${CYAN}${BOLD}   ⏳  Welcome to the Horai Backend Setup  ⏳   ${NC}"
echo -e "${CYAN}${BOLD}=====================================================${NC}"
echo -e "This script will guide you through setting up your workspace on your new laptop."
echo ""

# -----------------------------------------------------------------
# 1. System Requirements Check
# -----------------------------------------------------------------
echo -e "${BLUE}${BOLD}[1/5] Checking System Requirements...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed.${NC}"
    echo -e "Please install Node.js (version >= 18.0.0) first: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2)
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d'.' -f1)

if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}Error: Node.js version is v$NODE_VERSION. Version >= 18.0.0 is required.${NC}"
    exit 1
else
    echo -e "${GREEN}✓ Node.js v$NODE_VERSION detected.${NC}"
fi

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}Error: npm is not installed.${NC}"
    exit 1
else
    NPM_VERSION=$(npm -v)
    echo -e "${GREEN}✓ npm v$NPM_VERSION detected.${NC}"
fi

# Check psql (Warning only, since they might use a remote DB or Docker)
PSQL_AVAILABLE=true
if ! command -v psql &> /dev/null; then
    PSQL_AVAILABLE=false
    echo -e "${YELLOW}⚠ PostgreSQL client ('psql') not found in PATH.${NC}"
    echo -e "  (You can still complete the setup if using a remote DB or Docker, but automatic DB creation will be skipped.)"
else
    echo -e "${GREEN}✓ PostgreSQL client ('psql') detected.${NC}"
fi

echo -e "${GREEN}${BOLD}Requirements check complete!${NC}\n"

# -----------------------------------------------------------------
# 2. Environment Configuration (.env)
# -----------------------------------------------------------------
echo -e "${BLUE}${BOLD}[2/5] Configuring Environment Variables...${NC}"

# Ensure .env.example exists (in case it got deleted or missed)
if [ ! -f ".env.example" ]; then
    echo -e "${YELLOW}Warning: .env.example not found. Re-creating it...${NC}"
    cat <<EOT > .env.example
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=horai_db
DB_USER=postgres
DB_PASSWORD=your_postgres_password

# Auth
JWT_SECRET=
JWT_EXPIRES_IN=7d

# Server
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000
EOT
fi

ENV_EXISTS=false
if [ -f ".env" ]; then
    ENV_EXISTS=true
    echo -e "${YELLOW}An existing .env file was found.${NC}"
    read -p "Would you like to keep it and skip database configuration? (y/n) [y]: " KEEP_ENV
    KEEP_ENV=${KEEP_ENV:-y}
    
    if [ "$KEEP_ENV" = "y" ] || [ "$KEEP_ENV" = "Y" ]; then
        echo -e "${GREEN}✓ Keeping existing .env file.${NC}"
        # Source existing .env variables for DB creation step
        export $(grep -v '^#' .env | xargs)
    else
        # Backup the old .env
        BACKUP_FILE=".env.backup.$(date +%F_%H%M%S)"
        cp .env "$BACKUP_FILE"
        echo -e "${YELLOW}Backed up existing .env to $BACKUP_FILE${NC}"
        ENV_EXISTS=false
    fi
fi

if [ "$ENV_EXISTS" = "false" ]; then
    echo -e "Let's configure your database connection parameters:"
    
    read -p "Database Host [localhost]: " DB_HOST
    DB_HOST=${DB_HOST:-localhost}
    
    read -p "Database Port [5432]: " DB_PORT
    DB_PORT=${DB_PORT:-5432}
    
    read -p "Database Name [horai_db]: " DB_NAME
    DB_NAME=${DB_NAME:-horai_db}
    
    read -p "Database User [postgres]: " DB_USER
    DB_USER=${DB_USER:-postgres}
    
    read -sp "Database Password: " DB_PASSWORD
    echo ""
    
    read -p "Application Port [3000]: " PORT
    PORT=${PORT:-3000}
    
    # Generate high-entropy JWT_SECRET using Node crypto module
    echo -e "${BLUE}Generating secure random JWT_SECRET...${NC}"
    JWT_SECRET=$(node -e "try { console.log(require('crypto').randomBytes(48).toString('hex')); } catch(e) { console.log(''); }")
    if [ -z "$JWT_SECRET" ]; then
        # Fallback to openssl
        JWT_SECRET=$(openssl rand -hex 48 2>/dev/null || true)
    fi
    if [ -z "$JWT_SECRET" ]; then
        # Simple backup fallback
        JWT_SECRET=$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 48)
    fi

    # Write new .env file
    cat <<EOT > .env
# Database
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD

# Auth
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=7d

# Server
PORT=$PORT
NODE_ENV=development
BASE_URL=http://localhost:$PORT
EOT
    echo -e "${GREEN}✓ Created new .env file with secure configuration.${NC}"
fi
echo ""

# -----------------------------------------------------------------
# 3. PostgreSQL Database Setup
# -----------------------------------------------------------------
echo -e "${BLUE}${BOLD}[3/5] Setting up PostgreSQL Database...${NC}"

if [ "$PSQL_AVAILABLE" = "true" ]; then
    echo -e "Verifying connection to PostgreSQL on ${DB_HOST}:${DB_PORT} as user '${DB_USER}'..."
    
    # Check if postgres connection works
    if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "SELECT 1" &> /dev/null; then
        echo -e "${GREEN}✓ Successfully connected to PostgreSQL server!${NC}"
        
        # Check if DB exists
        DB_EXISTS=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")
        if [ "$DB_EXISTS" = "1" ]; then
            echo -e "${GREEN}✓ Database '$DB_NAME' already exists.${NC}"
        else
            echo -e "${BLUE}Creating database '$DB_NAME'...${NC}"
            if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME;" &> /dev/null; then
                echo -e "${GREEN}✓ Database '$DB_NAME' created successfully!${NC}"
            else
                echo -e "${RED}✗ Failed to create database '$DB_NAME' automatically.${NC}"
                echo -e "Please run this command manually in psql to create the database:"
                echo -e "    CREATE DATABASE $DB_NAME;"
                echo ""
                read -p "Press [Enter] to continue setup anyway..."
            fi
        fi
    else
        echo -e "${YELLOW}⚠ Could not connect to PostgreSQL with these credentials.${NC}"
        echo -e "Please ensure PostgreSQL is running and your credentials are correct."
        echo -e "Common solutions:"
        echo -e "  - Start service: 'sudo service postgresql start' or 'brew services start postgresql'"
        echo -e "  - Create the role: 'createuser -s -U postgres $DB_USER' (if role doesn't exist)"
        echo ""
        read -p "Press [Enter] to bypass connection check and continue setup..."
    fi
else
    echo -e "${YELLOW}Skipping automatic database creation (psql utility not available).${NC}"
    echo -e "Please make sure your database server is running and database '$DB_NAME' is created manually."
    echo ""
    read -p "Press [Enter] to continue..."
fi
echo ""

# -----------------------------------------------------------------
# 4. Install Node Dependencies
# -----------------------------------------------------------------
echo -e "${BLUE}${BOLD}[4/5] Installing Dependencies...${NC}"
echo -e "Running 'npm install' — this may take a moment..."
npm install
echo -e "${GREEN}✓ Dependencies installed successfully!${NC}\n"

# -----------------------------------------------------------------
# 5. Run Database Migrations
# -----------------------------------------------------------------
echo -e "${BLUE}${BOLD}[5/5] Running Database Migrations...${NC}"
if [ "$PSQL_AVAILABLE" = "true" ]; then
    echo -e "Applying migrations via Knex..."
    if npm run migrate; then
        echo -e "${GREEN}✓ Database schema is up to date!${NC}\n"
    else
        echo -e "${RED}✗ Migration failed.${NC}"
        echo -e "Make sure PostgreSQL is running, the database '$DB_NAME' is created, and your .env configuration is correct."
        echo -e "Then, run migrations manually with: ${BOLD}npm run migrate${NC}"
        echo ""
        read -p "Press [Enter] to complete setup anyway..."
    fi
else
    echo -e "${YELLOW}Skipping automatic migrations. Run them manually with 'npm run migrate' once your database is ready.${NC}\n"
fi

# -----------------------------------------------------------------
# Setup Complete Summary
# -----------------------------------------------------------------
echo -e "${GREEN}${BOLD}=====================================================${NC}"
echo -e "${GREEN}${BOLD} 🎉  Setup Complete! Horai Backend is Ready!  🎉 ${NC}"
echo -e "${GREEN}${BOLD}=====================================================${NC}"
echo ""
echo -e "You can now run the following commands to start working:"
echo ""
echo -e "  ${BOLD}npm run dev${NC}"
echo -e "    Starts the development server on http://localhost:$PORT with hot reloading."
echo ""
echo -e "  ${BOLD}npm start${NC}"
echo -e "    Starts the production server."
echo ""
echo -e "  ${BOLD}npm test${NC}"
echo -e "    Runs the Jest test suite."
echo ""
echo -e "${CYAN}${BOLD}Tunneling & Deployment:${NC}"
echo -e "If you are connecting from a remote frontend, expose the API using ngrok:"
echo -e "  ${BOLD}ngrok http $PORT${NC}"
echo -e "Then set the resulting URL in your ${BOLD}.env${NC} file as ${BOLD}BASE_URL${NC}."
echo ""
echo -e "Happy coding! 🚀"
echo -e "${CYAN}=====================================================${NC}"
