import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runAppleScript(script, args = []) {
  const { stdout } = await execFileAsync("osascript", ["-e", script, "--", ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export async function askText(title, message, defaultValue = "", hidden = false) {
  const script = `on run argv
set dialogTitle to item 1 of argv
set dialogMessage to item 2 of argv
set defaultValue to item 3 of argv
set hiddenAnswer to (item 4 of argv is "true")
try
  if hiddenAnswer then
    set answer to display dialog dialogMessage with title dialogTitle default answer defaultValue buttons {"Annulla", "Continua"} default button "Continua" cancel button "Annulla" with hidden answer
  else
    set answer to display dialog dialogMessage with title dialogTitle default answer defaultValue buttons {"Annulla", "Continua"} default button "Continua" cancel button "Annulla"
  end if
  return text returned of answer
on error number -128
  return "__CANCEL__"
end try
end run`;
  const result = await runAppleScript(script, [title, message, defaultValue, String(hidden)]);
  return result === "__CANCEL__" ? undefined : result;
}

export async function chooseOne(title, message, choices, defaultChoice) {
  if (!choices.length) return undefined;
  const script = `on run argv
set dialogTitle to item 1 of argv
set dialogMessage to item 2 of argv
set defaultChoice to item 3 of argv
set rawChoices to items 4 thru -1 of argv
try
  set picked to choose from list rawChoices with title dialogTitle with prompt dialogMessage default items {defaultChoice} OK button name "Continua" cancel button name "Annulla" without multiple selections allowed
  if picked is false then return "__CANCEL__"
  return item 1 of picked
on error number -128
  return "__CANCEL__"
end try
end run`;
  const result = await runAppleScript(script, [title, message, defaultChoice ?? choices[0], ...choices]);
  return result === "__CANCEL__" ? undefined : result;
}

export async function chooseMany(title, message, choices) {
  if (!choices.length) return undefined;
  const script = `on run argv
set dialogTitle to item 1 of argv
set dialogMessage to item 2 of argv
set rawChoices to items 3 thru -1 of argv
try
  set picked to choose from list rawChoices with title dialogTitle with prompt dialogMessage OK button name "Continua" cancel button name "Annulla" with multiple selections allowed
  if picked is false then return "__CANCEL__"
  set previousDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set resultText to picked as text
  set AppleScript's text item delimiters to previousDelimiters
  return resultText
on error number -128
  return "__CANCEL__"
end try
end run`;
  const result = await runAppleScript(script, [title, message, ...choices]);
  if (result === "__CANCEL__" || !result) return undefined;
  return result.split("\n");
}

export async function confirm(title, message, okLabel = "Conferma") {
  const script = `on run argv
try
  display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Annulla", item 3 of argv} default button (item 3 of argv) cancel button "Annulla"
  return "yes"
on error number -128
  return "no"
end try
end run`;
  return (await runAppleScript(script, [title, message, okLabel])) === "yes";
}

export async function notify(title, message) {
  const script = `on run argv
display notification (item 2 of argv) with title (item 1 of argv)
end run`;
  await runAppleScript(script, [title, message]);
}

export async function keychainSet(service, account, value) {
  // macOS `security -w` without a value reads from the controlling terminal,
  // not stdin. Passing the value explicitly is required for a non-interactive
  // helper and stores the complete JWT instead of the prompt text.
  await execFileAsync("security", ["add-generic-password", "-U", "-a", account, "-s", service, "-w", value]);
}

export async function keychainGet(service, account) {
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function keychainDelete(service, account) {
  try {
    await execFileAsync("security", ["delete-generic-password", "-a", account, "-s", service]);
  } catch {
    // Already absent.
  }
}
