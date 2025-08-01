import { HistoryList } from '../LinkedList';

describe(HistoryList.name, () => {
	const TEST_DELAY = 10;
	let historyList: HistoryList<Array<Number>>;

	beforeEach(() => {
		historyList = new HistoryList(TEST_DELAY);
	});

	describe(HistoryList.prototype.push.name, () => {
		it('should not directly add items to the list', () => {
			historyList.push([1, 2, 3]);
			expect(historyList.getCurrent()).toBeNull();
		});

		it('should add items to the list after a delay', async () => {
			historyList.push([1, 2, 3]);
			await new Promise(resolve => setTimeout(resolve, TEST_DELAY));
			expect(historyList.getCurrent()).toEqual([1, 2, 3]);
		});

		it('should not add items when there are items kept being added', async () => {
			historyList.push([1, 2, 3]);
			await new Promise(resolve => setTimeout(resolve, TEST_DELAY - 5));
			historyList.push([4, 5, 6]);
			await new Promise(resolve => setTimeout(resolve, TEST_DELAY - 5));
			historyList.push([7, 8, 9]);
			expect(historyList.getCurrent()).toBeNull();
		});

		it('should add all the items cummutatively', async () => {
			historyList.push([1, 2, 3]);
			await new Promise(resolve => setTimeout(resolve, TEST_DELAY - 5));
			historyList.push([4, 5, 6]);
			await new Promise(resolve => setTimeout(resolve, TEST_DELAY - 5));
			historyList.push([7, 8, 9]);

			await new Promise(resolve => setTimeout(resolve, TEST_DELAY));

			expect(historyList.getCurrent()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		});
	});

	describe(HistoryList.prototype.flush.name, () => {
		it('should flush the pending changes', async () => {
			historyList.push([1, 2, 3]);
			await new Promise(resolve => setTimeout(resolve, TEST_DELAY - 5));
			historyList.flush();
			expect(historyList.getCurrent()).toEqual([1, 2, 3]);
		});
	});

	describe(HistoryList.prototype.back.name, () => {
		it('should go back to the previous state', async () => {
			historyList.push([1, 2, 3]); // 1
			historyList.flush();
			historyList.push([4, 5, 6]); // 2
			historyList.flush();
			historyList.push([7, 8, 9]); // 3
			historyList.flush();

			const result = historyList.back(); // 2

			expect(result).toEqual([4, 5, 6]);
		});

		it('can not go back before the first state', async () => {
			historyList.push([1, 2, 3]); // 1
			historyList.flush();

			const result = historyList.back(); // 0

			expect(result).toBeNull();
		});
	});

	describe(HistoryList.prototype.forward.name, () => {
		it('should go forward to the next state', async () => {
			historyList.push([1, 2, 3]); // 1
			historyList.flush();
			historyList.push([4, 5, 6]); // 2
			historyList.flush();
			historyList.push([7, 8, 9]); // 3
			historyList.flush();

			historyList.back(); // 2
			historyList.back(); // 1

			const result = historyList.forward(); // 2
			expect(result).toEqual([4, 5, 6]);
		});

		it('can not go forward after the last state', async () => {
			historyList.push([1, 2, 3]); // 1
			historyList.flush();

			const result = historyList.forward(); // 2
			expect(result).toBeNull();
		});
	});
});
