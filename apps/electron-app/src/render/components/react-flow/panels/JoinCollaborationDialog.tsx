import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogClose,
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
	InputOTP,
	InputOTPGroup,
	InputOTPSlot,
	toast,
	InputOTPSeparator,
} from '@microflow/ui';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as Zod from 'zod';
import { useCollaborationActions } from '../../../stores/yjs';
import { isValidOTP } from '../../../../common/otp';

const schema = Zod.object({
	otpCode: Zod.string()
		.min(6, 'OTP code must be 6 digits')
		.max(6, 'OTP code must be 6 digits')
		.refine(isValidOTP, 'Please enter a valid 6-digit code'),
});

type Schema = Zod.infer<typeof schema>;

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function JoinCollaborationDialog(props: Props) {
	const { connect } = useCollaborationActions();
	const form = useForm({
		resolver: zodResolver(schema),
		defaultValues: {
			otpCode: '',
		},
	});

	function onSubmit(data: Schema) {
		connect(data.otpCode, { isJoining: true }); // Pass options to indicate this is a join operation
		toast.info('Joining collaboration session...');
		form.reset();
		props.onOpenChange(false);
	}

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Join a collaboration session</DialogTitle>
					<DialogDescription>
						Enter the 6-digit code provided by the session host to join.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)}>
						<fieldset className='mb-6'>
							<FormField
								control={form.control}
								name='otpCode'
								render={({ field }) => (
									<FormItem>
										<FormLabel>Session Code</FormLabel>
										<FormControl>
											<InputOTP maxLength={6} value={field.value} onChange={field.onChange}>
												<InputOTPGroup>
													<InputOTPSlot index={0} />
													<InputOTPSlot index={1} />
													<InputOTPSlot index={2} />
												</InputOTPGroup>
												<InputOTPSeparator />
												<InputOTPGroup>
													<InputOTPSlot index={3} />
													<InputOTPSlot index={4} />
													<InputOTPSlot index={5} />
												</InputOTPGroup>
											</InputOTP>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</fieldset>
						<DialogFooter>
							<DialogClose asChild>
								<Button type='button' variant='secondary'>
									Cancel
								</Button>
							</DialogClose>
							<Button type='submit'>Join session</Button>
						</DialogFooter>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
}
