# Supabase

This directory contains Supabase/PostgreSQL-specific project files for NyxEclipse.

## Production database

NyxEclipse should use the Supabase PostgreSQL connection string through the hosting platform environment variable:

```env
POSTGRES_URL=<SUPABASE_SESSION_POOLER_CONNECTION_STRING>
```

Do not commit real Supabase credentials, database passwords, service-role keys, or connection strings containing secrets.

## Recommended connection

For Bot-Hosting deployments, use the Supabase **Session Pooler** connection when IPv4 compatibility is required. Keep SSL enabled as provided by Supabase.

## Directory layout

```text
supabase/
├── README.md
└── migrations/
    └── <timestamp>_<description>.sql
```

Database migrations belong in `supabase/migrations/` and should be safe to apply in order.

## Local development

The local PostgreSQL database can remain separate from production. Production credentials belong in Bot-Hosting environment variables, not in this repository.
