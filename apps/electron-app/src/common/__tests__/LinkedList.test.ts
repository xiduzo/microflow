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
			historyList.push([1, 2, 3]);
			historyList.flush();
			historyList.push([4, 5, 6]);
			historyList.flush();
			historyList.push([7, 8, 9]);
			historyList.flush();
			historyList.back();
			expect(historyList.getCurrent()).toEqual([4, 5, 6]);
		});

		it('should stick with the first state when going back too many times', () => {
			historyList.push([1, 2, 3]);
			historyList.flush();
			historyList.push([4, 5, 6]);
			historyList.flush();
			historyList.back();
			historyList.back();
			historyList.back();
			expect(historyList.getCurrent()).toEqual([1, 2, 3]);
		});
	});

	describe(HistoryList.prototype.forward.name, () => {
		it('should go forward to the next state', async () => {
			historyList.push([1, 2, 3]);
			historyList.flush();
			historyList.push([4, 5, 6]);
			historyList.flush();
			historyList.push([7, 8, 9]);
			historyList.flush();
			historyList.back();
			historyList.back();
			historyList.forward();
			expect(historyList.getCurrent()).toEqual([4, 5, 6]);
		});

		it('should stick with the last state when going forward too many times', () => {
			historyList.push([1, 2, 3]);
			historyList.flush();
			historyList.push([4, 5, 6]);
			historyList.flush();
			historyList.push([7, 8, 9]);
			historyList.flush();
			historyList.back();
			historyList.back();
			historyList.forward();
			historyList.forward();
			historyList.forward();
			historyList.forward();
			expect(historyList.getCurrent()).toEqual([7, 8, 9]);
		});
	});
});
