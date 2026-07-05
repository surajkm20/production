import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import SignupPage from './pages/SignupPage'
import OtpPage from './pages/OtpPage'
import ForgotPasswordPage from './pages/ForgotPasswordPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import HomePage from './pages/HomePage'
import AdminDashboardPage from './pages/AdminDashboardPage'
import CreateGroupPage from './pages/CreateGroupPage'
import MembersPage from './pages/MembersPage'
import MemberDashboardPage from './pages/MemberDashboardPage'
import MarkPaymentsPage from './pages/MarkPaymentsPage'
import BasketPage from './pages/BasketPage'
import RecordWinnerPage from './pages/RecordWinnerPage'
import ProfilePage from './pages/ProfilePage'
import HistoryPage from './pages/HistoryPage'
import CycleDetailPage from './pages/CycleDetailPage'
import AnalyticsPage from './pages/AnalyticsPage'
import AllWinnersPage from './pages/AllWinnersPage'
import MyLoansPage from './pages/MyLoansPage'
import SuperAdminConsolePage from './pages/SuperAdminConsolePage'
import ActivityPage from './pages/ActivityPage'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('access_token')
  return token ? <>{children}</> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/otp" element={<OtpPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/dashboard" element={<PrivateRoute><HomePage /></PrivateRoute>} />
        <Route path="/groups/new" element={<PrivateRoute><CreateGroupPage /></PrivateRoute>} />
        <Route path="/groups/:groupId" element={<PrivateRoute><AdminDashboardPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/members" element={<PrivateRoute><MembersPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/member" element={<PrivateRoute><MemberDashboardPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/payments" element={<PrivateRoute><MarkPaymentsPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/basket" element={<PrivateRoute><BasketPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/record-winner" element={<PrivateRoute><RecordWinnerPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/activity" element={<PrivateRoute><ActivityPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/history" element={<PrivateRoute><HistoryPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/history/:cycleId" element={<PrivateRoute><CycleDetailPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/analytics" element={<PrivateRoute><AnalyticsPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/winners" element={<PrivateRoute><AllWinnersPage /></PrivateRoute>} />
        <Route path="/groups/:groupId/my-loans" element={<PrivateRoute><MyLoansPage /></PrivateRoute>} />
        <Route path="/profile" element={<PrivateRoute><ProfilePage /></PrivateRoute>} />
        <Route path="/admin" element={<PrivateRoute><SuperAdminConsolePage /></PrivateRoute>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
