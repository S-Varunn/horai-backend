# Horai Backend Smooth Setup Script for Windows (PowerShell)
# Works natively on any Windows laptop running PowerShell 5.1+

$ErrorActionPreference = "Stop"

# Clear terminal screen
Clear-Host

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "   ⏳  Welcome to the Horai Backend Setup  ⏳   " -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "This script will guide you through setting up your workspace on Windows."
Write-Host ""

# -----------------------------------------------------------------
# 1. System Requirements Check
# -----------------------------------------------------------------
Write-Host "[1/5] Checking System Requirements..." -ForegroundColor Blue

# Check Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Host "Error: Node.js is not installed." -ForegroundColor Red
    Write-Host "Please install Node.js (version >= 18.0.0) from https://nodejs.org/" -ForegroundColor Red
    exit 1
}

$nodeVersion = (node -v).Trim().Substring(1) # remove 'v'
$nodeMajor = [int]($nodeVersion.Split('.')[0])

if ($nodeMajor -lt 18) {
    Write-Host "Error: Node.js version is v$nodeVersion. Version >= 18.0.0 is required." -ForegroundColor Red
    exit 1
} else {
    Write-Host "✓ Node.js v$nodeVersion detected." -ForegroundColor Green
}

# Check npm
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($null -eq $npm) {
    Write-Host "Error: npm is not installed." -ForegroundColor Red
    exit 1
} else {
    $npmVersion = (npm -v).Trim()
    Write-Host "✓ npm v$npmVersion detected." -ForegroundColor Green
}

# Check psql
$psql = Get-Command psql -ErrorAction SilentlyContinue
$psqlAvailable = $null -ne $psql
if (-not $psqlAvailable) {
    Write-Host "⚠ PostgreSQL client ('psql') not found in PATH." -ForegroundColor Yellow
    Write-Host "  (You can still complete the setup if using a remote DB or Docker, but automatic DB creation will be skipped.)"
} else {
    Write-Host "✓ PostgreSQL client ('psql') detected." -ForegroundColor Green
}
Write-Host "Requirements check complete!`n" -ForegroundColor Green

# -----------------------------------------------------------------
# 2. Environment Configuration (.env)
# -----------------------------------------------------------------
Write-Host "[2/5] Configuring Environment Variables..." -ForegroundColor Blue

if (-not (Test-Path ".env.example")) {
    Write-Host "Warning: .env.example not found. Re-creating it..." -ForegroundColor Yellow
    $exampleContent = @"
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
"@
    Set-Content -Path ".env.example" -Value $exampleContent
}

$envExists = Test-Path ".env"
if ($envExists) {
    Write-Host "An existing .env file was found." -ForegroundColor Yellow
    $keepEnv = Read-Host "Would you like to keep it and skip database configuration? (y/n) [y]"
    if ($null -eq $keepEnv -or $keepEnv -eq "" -or $keepEnv -eq "y" -or $keepEnv -eq "Y") {
        Write-Host "✓ Keeping existing .env file." -ForegroundColor Green
        # Load environment variables from .env to session env variables
        Get-Content .env | Where-Object { $_ -match '=' -and -not $_.StartsWith('#') } | ForEach-Object {
            $parts = $_.Split('=', 2)
            $envName = $parts[0].Trim()
            $envVal = $parts[1].Trim()
            Set-Item -Path "env:$envName" -Value $envVal
        }
    } else {
        $backupFile = ".env.backup.$(Get-Date -Format "yyyyMMdd_HHmmss")"
        Copy-Item ".env" "$backupFile"
        Write-Host "Backed up existing .env to $backupFile" -ForegroundColor Yellow
        $envExists = $false
    }
}

if (-not $envExists) {
    Write-Host "Let's configure your database connection parameters:"
    
    $DB_HOST = Read-Host "Database Host [localhost]"
    if ($null -eq $DB_HOST -or $DB_HOST -eq "") { $DB_HOST = "localhost" }
    
    $DB_PORT = Read-Host "Database Port [5432]"
    if ($null -eq $DB_PORT -or $DB_PORT -eq "") { $DB_PORT = "5432" }
    
    $DB_NAME = Read-Host "Database Name [horai_db]"
    if ($null -eq $DB_NAME -or $DB_NAME -eq "") { $DB_NAME = "horai_db" }
    
    $DB_USER = Read-Host "Database User [postgres]"
    if ($null -eq $DB_USER -or $DB_USER -eq "") { $DB_USER = "postgres" }
    
    $DB_PASSWORD = Read-Host -AsSecureString "Database Password"
    # Convert SecureString to plain text
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($DB_PASSWORD)
    $DB_PASSWORD_PLAIN = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
    
    $PORT = Read-Host "Application Port [3000]"
    if ($null -eq $PORT -or $PORT -eq "") { $PORT = "3000" }
    
    # Generate high-entropy JWT_SECRET
    Write-Host "Generating secure random JWT_SECRET..." -ForegroundColor Blue
    $JWT_SECRET = node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
    if ($null -eq $JWT_SECRET -or $JWT_SECRET -eq "") {
        # Fallback using random characters if Node fails (unlikely)
        $JWT_SECRET = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
    }
    
    $envContent = @"
# Database
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD_PLAIN

# Auth
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=7d

# Server
PORT=$PORT
NODE_ENV=development
BASE_URL=http://localhost:$PORT
"@
    Set-Content -Path ".env" -Value $envContent
    Write-Host "✓ Created new .env file with secure configuration." -ForegroundColor Green
    
    # Load variables to environment for subsequent database step
    $env:DB_HOST = $DB_HOST
    $env:DB_PORT = $DB_PORT
    $env:DB_NAME = $DB_NAME
    $env:DB_USER = $DB_USER
    $env:DB_PASSWORD = $DB_PASSWORD_PLAIN
}
Write-Host ""

# -----------------------------------------------------------------
# 3. PostgreSQL Database Setup
# -----------------------------------------------------------------
Write-Host "[3/5] Setting up PostgreSQL Database..." -ForegroundColor Blue

if ($psqlAvailable) {
    Write-Host "Verifying connection to PostgreSQL on $($env:DB_HOST):$($env:DB_PORT) as user '$($env:DB_USER)'..."
    $env:PGPASSWORD = $env:DB_PASSWORD
    
    # Try connecting to postgres database
    $connTest = & psql -h $env:DB_HOST -p $env:DB_PORT -U $env:DB_USER -d postgres -c "SELECT 1" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Successfully connected to PostgreSQL server!" -ForegroundColor Green
        
        # Check if DB exists
        $dbExists = & psql -h $env:DB_HOST -p $env:DB_PORT -U $env:DB_USER -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$($env:DB_NAME)'" 2>$null
        if ($dbExists.Trim() -eq "1") {
            Write-Host "✓ Database '$($env:DB_NAME)' already exists." -ForegroundColor Green
        } else {
            Write-Host "Creating database '$($env:DB_NAME)'..." -ForegroundColor Blue
            & psql -h $env:DB_HOST -p $env:DB_PORT -U $env:DB_USER -d postgres -c "CREATE DATABASE $($env:DB_NAME);" 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Host "✓ Database '$($env:DB_NAME)' created successfully!" -ForegroundColor Green
            } else {
                Write-Host "✗ Failed to create database '$($env:DB_NAME)' automatically." -ForegroundColor Red
                Write-Host "Please run this command manually in psql to create the database:"
                Write-Host "    CREATE DATABASE $($env:DB_NAME);"
                Read-Host "Press [Enter] to continue setup anyway..."
            }
        }
    } else {
        Write-Host "⚠ Could not connect to PostgreSQL with these credentials." -ForegroundColor Yellow
        Write-Host "Please ensure PostgreSQL is running and your credentials are correct."
        Write-Host "Common solutions on Windows:"
        Write-Host "  - Start service: Open Services app (services.msc), find your 'postgresql' service, and click 'Start'."
        Write-Host "  - Ensure user '$($env:DB_USER)' exists and has 'CREATEDB' permission."
        Write-Host ""
        Read-Host "Press [Enter] to bypass connection check and continue setup..."
    }
} else {
    Write-Host "Skipping automatic database creation (psql utility not available in PATH)." -ForegroundColor Yellow
    Write-Host "Please make sure your database server is running and database '$($env:DB_NAME)' is created manually."
    Read-Host "Press [Enter] to continue..."
}
Write-Host ""

# -----------------------------------------------------------------
# 4. Install Node Dependencies
# -----------------------------------------------------------------
Write-Host "[4/5] Installing Dependencies..." -ForegroundColor Blue
Write-Host "Running 'npm install' — this may take a moment..."
npm install
Write-Host "✓ Dependencies installed successfully!`n" -ForegroundColor Green

# -----------------------------------------------------------------
# 5. Run Database Migrations
# -----------------------------------------------------------------
Write-Host "[5/5] Running Database Migrations..." -ForegroundColor Blue
if ($psqlAvailable) {
    Write-Host "Applying migrations via Knex..."
    npm run migrate
    if ($LASTEXITCODE -eq 0) {
        Write-Host "✓ Database schema is up to date!`n" -ForegroundColor Green
    } else {
        Write-Host "✗ Migration failed." -ForegroundColor Red
        Write-Host "Make sure PostgreSQL is running, the database '$($env:DB_NAME)' is created, and your .env configuration is correct."
        Write-Host "Then, run migrations manually with: npm run migrate"
        Read-Host "Press [Enter] to complete setup anyway..."
    }
} else {
    Write-Host "Skipping automatic migrations. Run them manually with 'npm run migrate' once your database is ready.`n" -ForegroundColor Yellow
}

# -----------------------------------------------------------------
# Setup Complete Summary
# -----------------------------------------------------------------
Write-Host "=====================================================" -ForegroundColor Green
Write-Host " 🎉  Setup Complete! Horai Backend is Ready!  🎉 " -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Green
Write-Host ""
Write-Host "You can now run the following commands to start working:"
Write-Host ""
Write-Host "  npm run dev"
Write-Host "    Starts the development server on http://localhost:$($env:PORT) with hot reloading."
Write-Host ""
Write-Host "  npm start"
Write-Host "    Starts the production server."
Write-Host ""
Write-Host "  npm test"
Write-Host "    Runs the Jest test suite."
Write-Host ""
Write-Host "Tunneling & Deployment:" -ForegroundColor Cyan
Write-Host "If you are connecting from a remote frontend, expose the API using ngrok:"
Write-Host "  ngrok http $($env:PORT)"
Write-Host "Then set the resulting URL in your .env file as BASE_URL."
Write-Host ""
Write-Host "Happy coding! 🚀"
Write-Host "=====================================================" -ForegroundColor Cyan
