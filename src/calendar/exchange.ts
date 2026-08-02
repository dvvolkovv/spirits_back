// EWS (Exchange Web Services) коннектор для локального Exchange, когда публикация календаря
// сломана/закрыта, а Basic/CalDAV недоступны. Авторизация — NTLM (username = login@domain).
// Read-only: тянем CalendarView за окно, отдаём CalEvent'ы в co-pilot. Записи нет.
//
// ПОЧЕМУ curl, а не axios-ntlm: NTLMv2 через JS-библиотеки нестабилен на Node 20 (OpenSSL-3:
// MD4 доступен только в legacy-провайдере; axios-ntlm молча аутентифицируется с 401 на проде,
// хотя на Node 24 локально проходит). curl несёт собственную реализацию NTLM и стабильно
// отдаёт 200 и с прод-бокса, и локально — поэтому вызываем его через execFile (без shell).
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { CalEvent } from './calendar.types';

const execFileP = promisify(execFile);

export interface ExchangeCreds {
  server: string; // хост, напр. mail.clearwayintegration.com
  username: string; // NTLM username, храним как login@domain
  password: string;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Экранируем для curl-config («user = "…"»): внутри кавычек значимы \ и ".
function cfgEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class ExchangeEwsConnector {
  private ewsUrl(creds: ExchangeCreds): string {
    const host = creds.server.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return `https://${host}/EWS/Exchange.asmx`;
  }

  private findItemSoap(start: Date, end: Date): string {
    return (
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">' +
      '<soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>' +
      '<soap:Body><FindItem xmlns="http://schemas.microsoft.com/exchange/services/2006/messages" Traversal="Shallow">' +
      '<ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>' +
      '<t:FieldURI FieldURI="item:Subject"/><t:FieldURI FieldURI="calendar:Start"/><t:FieldURI FieldURI="calendar:End"/>' +
      '</t:AdditionalProperties></ItemShape>' +
      `<CalendarView MaxEntriesReturned="200" StartDate="${start.toISOString()}" EndDate="${end.toISOString()}"/>` +
      '<ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></ParentFolderIds>' +
      '</FindItem></soap:Body></soap:Envelope>'
    );
  }

  // curl --ntlm; креды кладём в 600-конфиг во временный файл (не в argv), удаляем в finally.
  private async post(creds: ExchangeCreds, soap: string, timeoutSec: number): Promise<string> {
    const cfg = join(tmpdir(), `.ews-${randomUUID()}.cfg`);
    await writeFile(cfg, `user = "${cfgEscape(creds.username)}:${cfgEscape(creds.password)}"\n`, { mode: 0o600 });
    try {
      const { stdout } = await execFileP(
        'curl',
        [
          '--ntlm', '-K', cfg, '-s', '--show-error', '--fail-with-body',
          '--max-time', String(timeoutSec),
          '-X', 'POST', this.ewsUrl(creds),
          '-H', 'Content-Type: text/xml; charset=utf-8',
          '--data', soap,
        ],
        { maxBuffer: 20 * 1024 * 1024, timeout: (timeoutSec + 5) * 1000 },
      );
      return stdout;
    } finally {
      await unlink(cfg).catch(() => {});
    }
  }

  /** Валидация кредов: короткое окно, успех = ответ содержит ResponseCode NoError. */
  async test(creds: ExchangeCreds): Promise<boolean> {
    try {
      const now = new Date();
      const xml = await this.post(creds, this.findItemSoap(now, new Date(now.getTime() + 864e5)), 15);
      return xml.includes('NoError');
    } catch {
      return false;
    }
  }

  async listEvents(creds: ExchangeCreds, start: Date, end: Date): Promise<CalEvent[]> {
    let xml: string;
    try {
      xml = await this.post(creds, this.findItemSoap(start, end), 15);
    } catch {
      return []; // недоступный источник не должен ронять co-pilot
    }
    const out: CalEvent[] = [];
    const items = xml.match(/<t:CalendarItem[\s\S]*?<\/t:CalendarItem>/g) || [];
    for (const it of items) {
      const s = (it.match(/<t:Start>([^<]+)<\/t:Start>/) || [])[1];
      if (!s) continue;
      const e = (it.match(/<t:End>([^<]+)<\/t:End>/) || [])[1];
      const subj = (it.match(/<t:Subject>([\s\S]*?)<\/t:Subject>/) || [])[1] || '(без темы)';
      const sd = new Date(s);
      if (isNaN(sd.getTime())) continue;
      const ed = e ? new Date(e) : null;
      out.push({
        at: sd.toISOString(),
        end: ed && !isNaN(ed.getTime()) ? ed.toISOString() : sd.toISOString(),
        title: decodeXml(subj).trim() || '(без темы)',
        source: 'outlook',
      });
    }
    return out;
  }
}
