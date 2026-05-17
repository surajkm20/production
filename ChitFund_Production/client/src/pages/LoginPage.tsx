import { useState } from 'react'
import HornPayLogo from '../components/HornPayLogo'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { api, ApiError } from '../lib/api'

// Maps backend error codes to user-friendly messages.
// The backend sends { error: { code: "INVALID_CREDENTIALS", message: "..." } }
// We show these strings instead of the raw backend message.
const ERROR_MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Incorrect mobile number/username or password.',
  MOBILE_NOT_VERIFIED: 'Your mobile number is not verified. Please complete OTP verification.',
  ACCOUNT_LOCKED: 'Your account has been locked due to too many failed attempts. Try again later.',
}

// Shape of the backend's response data on successful login.
// api.post<LoginResponse> tells TypeScript what to expect from the response.
interface LoginResponse {
  user_id: string
  access_token: string
  refresh_token: string
  expires_in: number
}

export default function LoginPage() {
  // useNavigate: programmatically redirect to another page (like res.redirect on backend)
  const navigate = useNavigate()
  // useLocation: read the current URL + any state passed via navigate()
  // OtpPage navigates here with { state: { verified: true } } after successful verification
  const location = useLocation()
  const locationState = location.state as { verified?: boolean; passwordReset?: boolean } | null
  const verified       = locationState?.verified      ?? false
  const passwordReset  = locationState?.passwordReset ?? false

  // useState holds form field values. Every keystroke updates these variables
  // and React re-renders the input to show the new value.
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  // error: null means no error banner shown; a string means the red box appears
  const [error, setError] = useState<string | null>(null)
  // loading: true while the API call is in-flight — disables the button and shows spinner
  const [loading, setLoading] = useState(false)

  // Runs when the user submits the form.
  // e.preventDefault() stops the browser from doing a full page reload (default HTML behavior).
  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      // api.post sends: POST /v1/auth/login  Body: { identifier, password }
      // On success, the backend returns { data: { access_token, refresh_token, ... } }
      // api.post unwraps the `data` envelope, so `data` here is LoginResponse directly.
      const data = await api.post<LoginResponse>('/auth/login', { identifier, password })

      // Store tokens in the browser's persistent key-value store (survives page refreshes).
      // PrivateRoute in App.tsx reads access_token from here to guard protected pages.
      localStorage.setItem('access_token', data.access_token)
      localStorage.setItem('refresh_token', data.refresh_token)

      // Redirect to the dashboard — equivalent to res.redirect('/dashboard') on the backend
      navigate('/dashboard')
    } catch (err) {
      // ApiError is thrown by lib/api.ts when the backend returns a non-2xx status.
      // err.code is the machine-readable code from the backend (e.g. "INVALID_CREDENTIALS").
      if (err instanceof ApiError) {
        setError(ERROR_MESSAGES[err.code] ?? err.message)
      } else {
        // Network failure, timeout, or unexpected error
        setError('Something went wrong. Please try again.')
      }
    } finally {
      // Always re-enable the button whether the call succeeded or failed
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <div className="mb-4">
            <HornPayLogo size={52} />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">HornPay</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to your account</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8">

          {/* Green banner shown after OTP verification or password reset */}
          {(verified || passwordReset) && (
            <div className="mb-5 flex gap-2 items-start bg-green-50 text-green-700 text-sm rounded-lg px-4 py-3 border border-green-200">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              {passwordReset ? 'Password reset successfully! You can now sign in.' : 'Account verified! You can now sign in.'}
            </div>
          )}

          {/* Error banner — only rendered when error state is non-null */}
          {error && (
            <div className="mb-5 flex gap-2 items-start bg-red-50 text-red-700 text-sm rounded-lg px-4 py-3 border border-red-200">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Mobile number or username
              </label>
              {/* value + onChange = "controlled input": React owns the value, not the browser.
                  Every keystroke fires onChange → setIdentifier → React re-renders with new value. */}
              <input
                type="text"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                placeholder="+91 98765 43210"
                required
                autoComplete="username"
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label className="block text-sm font-medium text-gray-700">Password</label>
                <Link to="/forgot-password" className="text-xs text-maroon-600 hover:text-maroon-500">
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                {/* showPassword toggles input type between "password" (masked) and "text" (visible) */}
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                  className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showPassword ? (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* disabled while loading to prevent duplicate submissions */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-maroon-600 hover:bg-maroon-700 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 rounded-lg transition focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:ring-offset-2"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Signing in...
                </span>
              ) : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Don't have an account?{' '}
          <Link to="/signup" className="text-maroon-600 font-medium hover:text-maroon-500">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  )
}
