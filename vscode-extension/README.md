# Mission Control for VS Code

Mission Control adds a task tree, commands, local-server connection management, and bounded notifications to VS Code. The default server URL is `http://127.0.0.1:4317`.

## Install or update

```powershell
npm --prefix vscode-extension ci
npm run extension:package
code --install-extension vscode-extension\dist\mission-control-0.1.0.vsix --force
```

Use **Mission Control: Show Logs** to open the `Mission Control` output channel for connection, startup, and diagnostic messages.

## Configuration and ownership

Set `missionControl.installationPath` to the folder containing the Mission Control `package.json` when VS Code should be allowed to start the local server. `missionControl.autoStart` defaults to `true`; the extension starts a server only when the configured loopback URL is unavailable, and a cross-window lock ensures that two VS Code windows do not start two servers. A server that was already running is never owned or stopped by the extension.

`missionControl.serverUrl` defaults to `http://127.0.0.1:4317`. Notification controls are `missionControl.notifications.enabled`, `missionControl.notifications.agentFinished`, `missionControl.notifications.ci`, and `missionControl.notifications.review`; the latter two cover CI passed/failed and review/approval notifications respectively.

The Command Palette provides six Mission Control commands: **Open Task**, **Run Current Phase**, **Open Dashboard**, **Restart Server**, **Show Logs**, and **View Session**. The tree also has Refresh and Filter controls.

Closing VS Code does not stop the Mission Control server or running agents; agents are detached processes and continue independently.

## Uninstall

```powershell
code --uninstall-extension otapiero.mission-control
```
