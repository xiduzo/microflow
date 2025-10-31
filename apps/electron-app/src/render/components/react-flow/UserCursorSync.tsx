import { useEffect } from 'react';
import { useAppStore } from '../../stores/app';
import { useUpdateLocalUser } from '../../stores/yjs';

export function UserCursorSync() {
	const user = useAppStore(state => state.user);
	const { updateLocalUserData } = useUpdateLocalUser();

	useEffect(() => {
		updateLocalUserData(user);
	}, [user, updateLocalUserData]);

	return null;
}
