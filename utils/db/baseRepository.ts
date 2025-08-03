import { type Table } from 'dexie';

/**
 * Base repository class that provides common database operations
 * Can be extended by specific repository classes
 */
export abstract class BaseRepository<T, K = string> {
  protected table: Table<T, K>;

  constructor(table: Table<T, K>) {
    this.table = table;
  }

  /**
   * Find a single record by primary key
   */
  async findByKey(key: K): Promise<T | undefined> {
    return this.table.get(key);
  }

  /**
   * Find all records
   */
  async findAll(): Promise<T[]> {
    return this.table.toArray();
  }

  /**
   * Save/update a record
   */
  async save(record: T): Promise<K> {
    return this.table.put(record);
  }

  /**
   * Create a new record
   */
  async create(record: T): Promise<K> {
    return this.table.add(record);
  }

  /**
   * Delete a record by key
   */
  async delete(key: K): Promise<void> {
    return this.table.delete(key);
  }

  /**
   * Count all records
   */
  async count(): Promise<number> {
    return this.table.count();
  }

  /**
   * Get the underlying Dexie table for advanced queries
   */
  getTable(): Table<T, K> {
    return this.table;
  }

  /**
   * Find records where a field equals a value
   */
  where(field: keyof T) {
    return this.table.where(field as string);
  }
}
