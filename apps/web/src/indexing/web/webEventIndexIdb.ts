/*
Copyright 2026 LESP-book

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** Convert one IndexedDB request into a promise. */
export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** Resolve after a transaction commits and reject if it aborts. */
export function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
    });
}

/** Add a record while treating an existing primary key as an idempotent duplicate. */
export function addRecord<T extends object>(store: IDBObjectStore, record: T): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const request = store.add(record);
        request.onsuccess = () => resolve(true);
        request.onerror = (event) => {
            if (request.error?.name === "ConstraintError") {
                event.preventDefault();
                resolve(false);
                return;
            }
            reject(request.error);
        };
    });
}
