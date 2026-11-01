# Invitations & Placement

Application privée de gestion d’événements, d’invitations personnalisées, de placement et d’accueil des invités.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server locally
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (development only)
- Required env: `DATABASE_URL` — PostgreSQL connection string
- Recommended production env: `NODE_ENV=production`, `FRONTEND_ORIGIN=https://your-domain.example`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/invite-manager/src/App.tsx` — frontend routes and user workflows.
- `artifacts/api-server/src/routes` — authenticated API routes and public invitation routes.
- `lib/api-spec/openapi.yaml` — API source of truth.
- `lib/db/src/schema` — PostgreSQL/Drizzle schema.
- `vercel.json` and `api/[...].ts` — Vercel frontend/API configuration.

## Architecture decisions

- Sessions use an HTTP-only cookie backed by PostgreSQL; passcodes are hashed with `scrypt`.
- Administrators can manage all events; organizers can access only events they created.
- Public invitation pages do not require authentication, while operational event data does.
- Check-ins can be queued locally and synchronized idempotently when the network returns.

## Product

Les équipes créent leurs événements, enregistrent les groupes invités, partagent des liens personnalisés, suivent les RSVP, attribuent les tables et enregistrent les arrivées par QR code, y compris avec une file hors connexion.

## User preferences

- Le dépôt contient des données potentiellement sensibles et doit rester privé.

## Gotchas

- Provisionner `DATABASE_URL` avant de lancer l’API ou `db push`.
- Configurer `FRONTEND_ORIGIN` en production pour limiter CORS et activer les cookies cross-origin correctement.
- Les organisateurs ne voient que les événements dont ils sont propriétaires ; les événements doivent donc être créés par le compte qui les gère.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
