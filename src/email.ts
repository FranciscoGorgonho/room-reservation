export interface EmailMessage {
  /** Estável entre tentativas, para o provedor descartar duplicatas. */
  dedupeId: string;
  to: string;
  subject: string;
  body: string;
}

/** Fronteira com o provedor real (SMTP, SES...). */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Provedor simulado, que pode ser "derrubado" para demonstrar uma indisponibilidade. */
export class FakeEmailSender implements EmailSender {
  down = false;
  readonly sent: (EmailMessage & { sentAt: string })[] = [];

  async send(message: EmailMessage): Promise<void> {
    if (this.down) throw new Error('Provedor de e-mail indisponível (simulado)');
    this.sent.unshift({ ...message, sentAt: new Date().toISOString() });
    this.sent.length = Math.min(this.sent.length, 1_000);
  }
}
