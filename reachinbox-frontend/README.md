# ReachInbox Frontend

Production-grade email scheduling dashboard built with Next.js, React, TypeScript, and Tailwind CSS.

## Features

- **Google OAuth Authentication** — Secure login with Google accounts
- **Dashboard** — View scheduled and sent emails with real-time status updates
- **Compose Email** — Rich text editor with recipient CSV upload
- **Schedule Picker** — Future date/time selection with quick presets
- **Slack Integration** — Connect Slack for rate limit notifications
- **Responsive Design** — Works on mobile, tablet, and desktop
- **Accessibility** — WCAG 2.1 AA compliant with keyboard navigation

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose (for backend)

### Setup

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local

# Edit .env.local with your credentials

# Start development server
npm run dev
```

### Environment Variables

| Variable | Description |
|---|---|
| `API_URL` | Backend API URL (default: http://localhost:3000) |
| `NEXTAUTH_URL` | NextAuth.js URL (default: http://localhost:3001) |
| `NEXTAUTH_SECRET` | Secret for NextAuth.js |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |

## Project Structure

```
src/
├── app/                    # Next.js app router pages
│   ├── layout.tsx          # Root layout
│   ├── page.tsx            # Dashboard home
│   ├── login/page.tsx      # Login page
│   ├── scheduled/page.tsx  # Scheduled emails
│   ├── sent/page.tsx       # Sent emails
│   └── compose/page.tsx    # Compose email
├── components/             # React components
│   ├── Dashboard.tsx       # Main dashboard
│   ├── Header.tsx          # App header with user info
│   ├── Sidebar.tsx         # Navigation sidebar
│   ├── ComposeModal.tsx    # Email compose modal
│   ├── SchedulePicker.tsx  # Date/time picker
│   ├── RichTextEditor.tsx  # Rich text editor
│   ├── SlackConnect.tsx    # Slack connection UI
│   └── ...
├── hooks/                  # Custom React hooks
│   ├── useAuth.ts          # Authentication hook
│   ├── useSchedules.ts     # Schedules data hook
│   ├── useEmails.ts        # Emails data hook
│   └── useSlack.ts         # Slack integration hook
├── lib/                    # Utilities and API client
│   ├── api/                # API client and types
│   └── utils.ts            # Helper functions
├── store/                  # Zustand state management
│   ├── authStore.ts        # Authentication state
│   └── toastStore.ts       # Toast notifications
├── workers/                # Web Workers
│   └── csvParser.ts        # CSV parsing worker
└── __tests__/              # Test files
```

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint

# Build for production
npm run build
```

## Docker

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f frontend

# Stop all services
docker-compose down
```

## API Integration

The frontend communicates with the backend via a typed API client that includes:

- Automatic idempotency key generation for mutations
- Correlation ID propagation for request tracing
- Error normalization and handling
- Credential-based authentication

## License

MIT
