// EWS (Exchange Web Services) коннектор для локального Exchange, когда публикация календаря
// сломана/закрыта, а Basic/CalDAV недоступны. Авторизация — NTLM (username = login@domain,
// domain пустой; так приняло curl и axios-ntlm против mail.clearwayintegration.com). Read-only:
// тянем CalendarView за окно и отдаём CalEvent'ы в co-pilot. Никакой записи.
import { NtlmClient } from 'axios-ntlm';
import { CalEvent } from './calendar.types';

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

export class ExchangeEwsConnector {
  private ewsUrl(creds: ExchangeCreds): string {
    return `https://${creds.server.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}/EWS/Exchange.asmx`;
  }

  private client(creds: ExchangeCreds) {
    // domain пустой — UPN (login@domain) уходит целиком в NTLM username, Exchange его резолвит.
    return NtlmClient({ username: creds.username, password: creds.password, domain: '', workstation: '' });
  }

  // FindItem с CalendarView разворачивает повторяющиеся встречи в отдельные вхождения окна —
  // ровно то, что нужно co-pilot'у (не нужно самим раскрывать RRULE).
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

  private async post(creds: ExchangeCreds, body: string, timeoutMs: number): Promise<string> {
    const res = await this.client(creds).post(this.ewsUrl(creds), body, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    if (res.status !== 200) throw new Error(`EWS HTTP ${res.status}`);
    return String(res.data);
  }

  /** Валидация кредов: короткое окно, успех = HTTP 200 + ResponseCode NoError. */
  async test(creds: ExchangeCreds): Promise<boolean> {
    try {
      const now = new Date();
      const xml = await this.post(creds, this.findItemSoap(now, new Date(now.getTime() + 864e5)), 15000);
      return xml.includes('NoError');
    } catch {
      return false;
    }
  }

  async listEvents(creds: ExchangeCreds, start: Date, end: Date): Promise<CalEvent[]> {
    let xml: string;
    try {
      xml = await this.post(creds, this.findItemSoap(start, end), 15000);
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
