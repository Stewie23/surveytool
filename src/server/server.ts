import { buildServer } from "./app.js";

const { app, config } = buildServer();

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`Server listening on http://localhost:${config.port}`);
  app.log.info(`Server listening on http://localhost:${config.port}`);
} catch (error) {
  app.log.error(error);
  console.error(error);
  process.exit(1);
}
