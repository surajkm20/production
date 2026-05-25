const BASE_URL = (import.meta.env.VITE_API_URL ?? '') + '/v1'

export class ApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  unwrap = true,
): Promise<T> {
  const token = localStorage.getItem('access_token')

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })

  const body = await res.json()

  if (!res.ok) {
    const err = body?.error
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN_ERROR', err?.message ?? 'Something went wrong')
  }

  return (unwrap ? body.data : body) as T
}

export const api = {
  post: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(data) }),

  get: <T>(path: string) =>
    request<T>(path, { method: 'GET' }),

  // Use when the response has useful fields alongside `data` (e.g. unread_count, has_more)
  getBody: <T>(path: string) =>
    request<T>(path, { method: 'GET' }, false),

  patch: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),

  put: <T>(path: string, data: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(data) }),

  delete: <T>(path: string) =>
    request<T>(path, { method: 'DELETE' }),

  correctCycle: (groupId: string, cycleId: string, data: { winner_user_id: string; bid_amount?: number; notes?: string; winner_number?: number }) =>
    request<{ cycle_id: string; winner_user_id: string; bid_amount?: number; basket_balance_after: number }>(
      `/groups/${groupId}/cycles/${cycleId}/correct`,
      { method: 'POST', body: JSON.stringify(data) },
    ),

  getChitiEligibility: (groupId: string) =>
    request<import('../types/api').ChitiEligibility>(`/groups/${groupId}/chiti-eligibility`),

  getMemberWins: (groupId: string, userId: string) =>
    request<import('../types/api').MemberWin[]>(`/groups/${groupId}/members/${userId}/wins`),

  bulkRepayMember: (groupId: string, body: { member_user_id: string; mode: 'interest_only' | 'principal_only' | 'full_settlement' }) =>
    request<import('../types/api').BulkRepayResponse>(`/groups/${groupId}/loans/bulk-repay`, { method: 'POST', body: JSON.stringify(body) }),

  editLoan: (groupId: string, loanId: string, body: { principal?: number; expected_close_date?: string; notes?: string }) =>
    request<import('../types/api').Loan>(`/groups/${groupId}/loans/${loanId}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteLoan: (groupId: string, loanId: string) =>
    request<{ deleted: boolean; loan_id: string }>(`/groups/${groupId}/loans/${loanId}`, { method: 'DELETE' }),
}
