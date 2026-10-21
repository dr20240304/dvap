import { HttpError } from './errors';

export interface PaymentDto {
  id: string;
  invoiceId: string;
  payeeId: string;
  payeeName: string;
  amount: string;
  status: 'pending_approval' | 'settled' | 'rejected' | 'denied' | 'failed';
  requestedBy: string;
  approvedBy: string | null;
  reason: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceDto {
  id: string;
  payeeId: string;
  payeeName: string;
  amount: string;
  memo: string;
  status: 'open' | 'paid';
  dueDate: string;
}

export interface AgentDto {
  id: string;
  publicKey: string;
  walletAccount: string;
  operatingAccount: string;
  scopes: string[];
}

/** Thin typed HTTP client for the ledger's internal API (service-key authenticated). */
export class LedgerClient {
  constructor(
    private baseUrl: string,
    private serviceKey: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-service-key': this.serviceKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new HttpError(res.status, data.error ?? 'ledger_error', data.message ?? `ledger ${res.status}`);
    return data as T;
  }

  getAgent = (id: string) => this.call<AgentDto>('GET', `/agents/${encodeURIComponent(id)}`);
  authAgent = (token: string) => this.call<AgentDto>('POST', '/auth/agent', { token });
  authApprover = (token: string) => this.call<{ id: string; name: string }>('POST', '/auth/approver', { token });
  listAccounts = () => this.call<{ accounts: { id: string; name: string; balance: string }[] }>('GET', '/accounts');
  getAccount = (id: string) => this.call<{ id: string; name: string; balance: string }>('GET', `/accounts/${encodeURIComponent(id)}`);
  listPayees = () => this.call<{ payees: { id: string; name: string; accountId: string; verified: boolean }[] }>('GET', '/payees');
  listInvoices = (status?: string) =>
    this.call<{ invoices: InvoiceDto[] }>('GET', `/invoices${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  createInvoice = (i: { id: string; vendor: string; amount: string; memo: string; dueDate: string }) => this.call<InvoiceDto>('POST', '/invoices', i);
  getInvoice = (id: string) => this.call<InvoiceDto>('GET', `/invoices/${encodeURIComponent(id)}`);
  createPayment = (p: { agentId: string; invoiceId: string; payeeId: string; amount: string; note?: string; override?: string }) => this.call<PaymentDto>('POST', '/payments', p);
  createPaymentsBatch = (agentId: string, payments: { invoiceId: string; payeeId: string; amount: string; note?: string }[]) =>
    this.call<{ payments: PaymentDto[] }>('POST', '/payments/batch', { agentId, payments });
  updatePolicy = (agentId: string, actor: string, patch: { perTxCap?: string; dailyCap?: string; allowPayees?: string[]; trustPayees?: string[] }) =>
    this.call<{ agentId: string; perTxCap: string; dailyCap: string; allowedPayees: string[] }>('PUT', `/agents/${encodeURIComponent(agentId)}/policy`, { actor, ...patch });
  getPayment = (id: string) => this.call<PaymentDto>('GET', `/payments/${encodeURIComponent(id)}`);
  listPayments = (status?: string) =>
    this.call<{ payments: PaymentDto[] }>('GET', `/payments${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  approvePayment = (id: string, approverToken: string) => this.call<PaymentDto>('POST', `/payments/${encodeURIComponent(id)}/approve`, { approverToken });
  rejectPayment = (id: string, approverToken: string, reason?: string) =>
    this.call<PaymentDto>('POST', `/payments/${encodeURIComponent(id)}/reject`, { approverToken, reason });
  transfer = (t: { from: string; to: string; amount: string; nonce: string; memo: string; payFee?: boolean }) =>
    this.call<{ transaction: string }>('POST', '/transfers', t);
  getTransfer = (id: string) => this.call<{ id: string; from: string; to: string; amount: string; kind: string; ref: string; memo: string }>('GET', `/transfers/${encodeURIComponent(id)}`);
  sponsorFee = () => this.call<{ charged: string }>('POST', '/sponsor/fee', {});
  nonceUsed = (nonce: string) => this.call<{ used: boolean }>('GET', `/nonces/${encodeURIComponent(nonce)}`);
  audit = (limit = 100) => this.call<{ entries: { id: number; ts: string; actor: string; action: string; detail: string }[] }>('GET', `/audit?limit=${limit}`);
}
