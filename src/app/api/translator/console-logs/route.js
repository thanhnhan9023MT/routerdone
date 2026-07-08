import { NextResponse } from "next/server";
import { clearConsoleLogs, getConsoleLogEntries, getConsoleLogs, initConsoleLogCapture, setConsoleLogRetentionMs } from "@/lib/consoleLogBuffer";
import { getSettings } from "@/lib/localDb";

initConsoleLogCapture();

async function applyRetentionSetting() {
  const settings = await getSettings();
  setConsoleLogRetentionMs(settings.consoleLogRetentionMs);
}

export async function GET() {
  try {
    await applyRetentionSetting();
    const logs = getConsoleLogs();
    const entries = getConsoleLogEntries();
    return NextResponse.json({ success: true, logs, entries });
  } catch (error) {
    console.error("Error getting console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await applyRetentionSetting();
    clearConsoleLogs();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error clearing console logs:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
