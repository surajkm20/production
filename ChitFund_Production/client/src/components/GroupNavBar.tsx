import { useNavigate, useLocation } from 'react-router-dom'

interface Props {
  groupId: string
  role: 'Admin' | 'Member'
}

export default function GroupNavBar({ groupId, role }: Props) {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const adminTabs = [
    { label: 'Members',   path: `/groups/${groupId}/members` },
    { label: 'History',   path: `/groups/${groupId}/history` },
    { label: 'Analytics', path: `/groups/${groupId}/analytics` },
    { label: 'Reports',   path: undefined as string | undefined },
  ]

  const memberTabs = [
    { label: 'Members',     path: `/groups/${groupId}/members` as string | undefined },
    { label: 'All winners', path: `/groups/${groupId}/winners` as string | undefined },
    { label: 'My loans',    path: `/groups/${groupId}/my-loans` as string | undefined },
    { label: 'Analytics',   path: `/groups/${groupId}/analytics` as string | undefined },
  ]

  const tabs = role === 'Admin' ? adminTabs : memberTabs

  return (
    <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-md bg-white border-t border-gray-100 flex z-10">
      {tabs.map(tab => {
        const active = !!tab.path && (
          pathname === tab.path || pathname.startsWith(tab.path + '/')
        )
        return (
          <button
            key={tab.label}
            onClick={() => tab.path && navigate(tab.path)}
            className={`flex-1 py-3 text-[11px] font-medium transition ${
              active
                ? 'text-maroon-600'
                : tab.path
                ? 'text-gray-600 hover:text-maroon-600'
                : 'text-gray-400 cursor-default'
            }`}
          >
            {tab.label}
          </button>
        )
      })}
    </div>
  )
}
