import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/flow/')({
    component: RouteComponent,
})

function RouteComponent() {
    return <Outlet />
}
