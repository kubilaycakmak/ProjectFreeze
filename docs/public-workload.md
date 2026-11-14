# Public HTTPS workload

ProjectFreeze can launch an application that listens on a routable IP. The application must explicitly opt in, and the operator supplies its network and TLS configuration. The bundled example serves a static `/health` response and holds no administrative routes. It defaults to `127.0.0.1` and refuses a non-loopback address without public opt-in and certificate and key files.

On the destination host set these environment references before starting the daemon. Use an IP assigned to the host. If the host sits behind NAT, use its local interface address and route traffic to it through your provider. Binding `0.0.0.0` or `::` listens on multiple interfaces.

| Variable | Example |
| --- | --- |
| `PF_DEMO_HOST` | Host's assigned IP address |
| `PF_DEMO_PORT` | `8443` |
| `PF_DEMO_PUBLIC` | `1` |
| `PF_DEMO_TLS_KEY` | Absolute path to private key |
| `PF_DEMO_TLS_CERT` | Absolute path to certificate chain |
| `PF_DEMO_STOP_FILE` | Optional unique path in a private directory for graceful shutdown |

Use a trusted certificate with the advertised DNS name or literal IP in its subject alternative names. Restrict private key access to the workload account. Limit inbound access to the intended interface and port at the host and provider firewall. Node's HTTPS server serves the example with a TLS 1.2 minimum. Public traffic to the example never reaches ProjectFreeze IPC or MCP. Configure production authentication and authorization in the application when it serves private data or performs actions.

Create a `recipe.json` pointing to the example included with the installed package. Adjust `cwd` and script path for your host.

```json
{
  "cwd": "/absolute/project/path",
  "argv": ["node", "/absolute/install/path/projectfreeze/examples/workload.js"],
  "env": ["PF_DEMO_HOST", "PF_DEMO_PORT", "PF_DEMO_PUBLIC", "PF_DEMO_TLS_KEY", "PF_DEMO_TLS_CERT"]
}
```

```sh
projectfreeze daemon start
projectfreeze run --recipe recipe.json
projectfreeze inspect PROJECT
curl --fail https://YOUR_PUBLIC_NAME_OR_IP:8443/health
```

Run the final request from an independent client to verify the actual public route. Use `projectfreeze discover --json` and `projectfreeze inspect PROJECT --json` to examine the listener on the host. A successful bind confirms only local listener setup.
