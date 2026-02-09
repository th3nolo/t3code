import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Could not resolve free port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", (error) => reject(error));
  });
}

function waitForProcessExit(processRef) {
  return new Promise((resolve) => {
    processRef.once("exit", (code) => resolve(code));
  });
}

async function main() {
  const [backendPort, webPort] = await Promise.all([getFreePort(), getFreePort()]);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = path.resolve(scriptDir, "..");
  const distCli = path.join(appRoot, "dist", "cli.js");
  if (!fs.existsSync(distCli)) {
    throw new Error("Missing dist/cli.js. Run `bun run --cwd apps/t3 build` first.");
  }

  const child = spawn(
    process.execPath,
    [
      distCli,
      "--no-open",
      "--backend-port",
      String(backendPort),
      "--web-port",
      String(webPort),
    ],
    {
      cwd: appRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await delay(2_000);

    const page = await fetch(`http://127.0.0.1:${webPort}`);
    if (page.status !== 200) {
      throw new Error(`Smoke test failed: expected web status 200, received ${page.status}.`);
    }

    const ws = new WebSocket(`ws://127.0.0.1:${backendPort}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Smoke test failed: websocket did not respond in time.")),
        20_000,
      );
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "request",
            id: "smoke",
            method: "todos.list",
          }),
        );
      });
      ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === "response" && message.id === "smoke" && message.ok === true) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Smoke test failed: websocket client error."));
      });
    });
    ws.close();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Smoke test failed."}\n`);
    process.stderr.write(output);
    process.exitCode = 1;
  } finally {
    child.kill();
    await waitForProcessExit(child);
  }
}

await main();
