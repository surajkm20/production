import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import HornPayLogo from '../components/HornPayLogo'

interface ForgotPasswordResponse {
  otp_sent: boolean
  otp_expires_at: string
}

export default function ForgotPasswordPage() {
  const navigate = useNavigate()
  const [mobile, setMobile] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const data = await api.post<ForgotPasswordResponse>('/auth/forgot-password', {
        mobile_number: mobile,
      })
      navigate('/reset-password', {
        state: { mobile_number: mobile, otp_expires_at: data.otp_expires_at },
      })
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'VALIDATION_ERROR') {
          setError('Please enter a valid mobile number in E.164 format (e.g. +919876543210).')
        } else {
          setError(err.message)
        }
      } else {
        setError('Something went wrong. Please try again.')
      }
    } finally {
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
          <h1 className="text-2xl font-bold text-gray-900">Forgot password?</h1>
          <p className="text-sm text-gray-500 mt-1">
            Enter your registered mobile number and we'll send you an OTP to reset your password.
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 px-6 py-8">

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
                Mobile number
              </label>
              <input
                type="tel"
                value={mobile}
                onChange={e => setMobile(e.target.value)}
                placeholder="+91 98765 43210"
                required
                autoComplete="tel"
                className="w-full px-3.5 py-2.5 rounded-lg border border-gray-300 text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-maroon-500 focus:border-transparent transition"
              />
              <p className="mt-1.5 text-xs text-gray-400">Include country code, e.g. +919876543210</p>
            </div>

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
                  Sending OTP...
                </span>
              ) : 'Send OTP'}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-gray-500 mt-6">
          Remember your password?{' '}
          <Link to="/login" className="text-maroon-600 font-medium hover:text-maroon-500">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  )
}
