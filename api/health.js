export function GET() {
  return Response.json({
    ok: true,
    service: "pipepilot-api",
    environment: process.env.VERCEL_ENV ?? "local",
  });
}
