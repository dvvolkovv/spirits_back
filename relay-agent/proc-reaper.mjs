// Уборка процессов, оставшихся от хода claude.
//
// Команды инструмента Bash claude запускает каждую в своей сессии (setsid),
// поэтому child.kill() по самому claude их не задевает. При нормальном выходе
// CLI гасит свои фоновые задачи сам, но не после SIGKILL — а именно им релей
// вытесняет ход, когда пользователь присылает новое сообщение. И никогда не
// гасит то, что модель оторвала сама (setsid, nohup … &).
//
// 14.10.2026 так осиротел OCR четырёх PDF на 83 страницы: ход убили через
// 13 минут после старта, а tesseract ещё больше двух часов держал load 16 на
// четырёх ядрах, хотя ответ пользователь давно получил другим путём.
//
// Ни группа процессов, ни сессия, ни родитель не переживают setsid и смерть
// claude. Переживает окружение: метку хода кладём в env claude, её наследует
// каждый потомок, а /proc/<pid>/environ своего пользователя читается без root.
// Не поймает запущенное через sudo (окружение сбрасывается, да и процессы root
// нам не убить) и запущенное с env -i.

import fs from "fs";
import path from "path";

export const RUN_ENV = "FILE_AGENT_RUN";

// Метка хода: "<pid релея>:<id хода>". pid отличает ходы прежнего экземпляра
// релея (умер при рестарте — убирать) от ходов живого чужого процесса
// (прогон тестов, второй экземпляр — не трогать).
export function runTag(runId, ownerPid = process.pid) {
  return ownerPid + ":" + runId;
}

// Процессы, несущие метку хода: [{ pid, tag, comm }]. Чужие (EACCES) и успевшие
// завершиться (ENOENT, ESRCH) пропускаются молча — /proc меняется под руками.
export async function taggedProcesses(procRoot = "/proc") {
  let names;
  try {
    names = await fs.promises.readdir(procRoot);
  } catch {
    return [];
  }
  const prefix = RUN_ENV + "=";
  const found = await Promise.all(names.filter((n) => /^\d+$/.test(n)).map(async (n) => {
    let env;
    try {
      env = await fs.promises.readFile(path.join(procRoot, n, "environ"), "latin1");
    } catch {
      return null;
    }
    const entry = env.split("\0").find((e) => e.startsWith(prefix));
    if (!entry) return null;
    let comm = "";
    try {
      comm = (await fs.promises.readFile(path.join(procRoot, n, "comm"), "utf8")).trim();
    } catch {}
    return { pid: Number(n), tag: entry.slice(prefix.length), comm };
  }));
  return found.filter(Boolean);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // процесс есть, просто не наш
  }
}

// Предикат «ход окончен» для обхода по таймеру. liveTags — метки ходов, чей
// claude ещё работает.
export function finishedRun(liveTags, selfPid = process.pid) {
  return (tag) => {
    const sep = tag.indexOf(":");
    const owner = Number(tag.slice(0, sep));
    if (sep <= 0 || !Number.isInteger(owner) || owner <= 0) return false;
    if (owner === selfPid) return !liveTags.has(tag);
    return !pidAlive(owner);
  };
}

function signal(pid, sig) {
  try { process.kill(pid, sig); } catch {}
}

// Гасит процессы оконченных ходов: SIGTERM, пауза на корректный выход, затем
// SIGKILL всем, кто остался. Возвращает список тех, кому ушёл SIGTERM.
export async function reap(isFinished, { graceMs = 3000, procRoot = "/proc" } = {}) {
  const victims = (await taggedProcesses(procRoot)).filter((p) => isFinished(p.tag));
  if (victims.length === 0) return [];
  for (const p of victims) signal(p.pid, "SIGTERM");
  await new Promise((r) => setTimeout(r, graceMs));
  // Второй обход заново, а не по первому списку: за паузу цикл в оболочке
  // успевает запустить следующую команду — новый pid, та же метка.
  for (const p of await taggedProcesses(procRoot)) {
    if (isFinished(p.tag)) signal(p.pid, "SIGKILL");
  }
  return victims;
}
