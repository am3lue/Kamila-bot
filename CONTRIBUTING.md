# Contributing to Kamila Bot

Thanks for your interest in contributing! This document provides guidelines for contributing to this project.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a feature branch: `git checkout -b feature/your-feature`
4. Make your changes
5. Test your changes
6. Commit with a clear message
7. Push and open a Pull Request

## Development Setup

```bash
# Clone your fork
git clone https://github.com/your-username/Kamila-Tsaap-Bot.git
cd Kamila-Tsaap-Bot

# Install dependencies
npm install

# Copy env file
cp .env.example .env

# Start in dev mode (auto-reload on changes)
npm run dev
```

## Project Structure

```
├── server.js          # Main server — bot logic, API, SSE, SQLite
├── public/
│   ├── dashboard.html # SPA shell
│   ├── dashboard.js   # Router, views, SSE client
│   ├── dashboard.css  # Dark theme styles
│   └── favicon.svg    # Bot icon
├── .env.example       # Config template
├── package.json
└── kamila.db          # SQLite database (auto-created, gitignored)
```

## Code Style

- ES Modules (`import`/`export`)
- No semicolons (optional, but be consistent)
- Use `const` by default, `let` when reassignment is needed
- Prefer template literals over string concatenation
- Keep functions focused and small
- Comment complex logic, not obvious code

## Pull Request Guidelines

- Keep PRs focused on one change
- Update documentation if your change affects usage
- Test manually with the bot and dashboard
- Write a clear PR description explaining what and why

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment (Node version, OS, browser)

## Feature Requests

Open an issue with:
- Use case (why you need this)
- Proposed solution (if you have one)
- Alternatives considered

## Questions?

Open a discussion or issue — happy to help.
