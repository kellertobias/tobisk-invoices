/* eslint-disable @typescript-eslint/no-unused-vars */
import { randomUUID } from 'crypto';

import { Query, Resolver, Mutation, Arg, Int, Authorized } from 'type-graphql';

import { ProductWhereInput, Product, ProductInput } from './product.schema';

import { Inject, Service } from '@/common/di';
import { ProductRepository } from '@/backend/repositories/product.repository';

@Service()
@Resolver(() => Product)
export class ProductResolver {
	constructor(
		@Inject(ProductRepository) private repository: ProductRepository,
	) {}

	@Authorized()
	@Query(() => [Product])
	async products(
		@Arg('where', () => ProductWhereInput, { nullable: true })
		where?: ProductWhereInput,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		@Arg('skip', () => Int, { nullable: true }) skip?: number,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		@Arg('limit', () => Int, { nullable: true }) limit?: number,
	): Promise<Product[]> {
		const data = await this.repository.listByQuery({
			where: { ...where },
			skip,
			limit,
		});

		return data
			.filter((product) => {
				if (where?.search) {
					return product.name.includes(where.search);
				}
				return true;
			})
			.sort((a, b) => {
				// First sort by category, then sort by name
				if (a.category === b.category) {
					return a.name.localeCompare(b.name);
				}
				return a.category.localeCompare(b.category);
			});
	}

	@Authorized()
	@Query(() => Product, { nullable: true })
	async product(@Arg('id') id: string): Promise<Product | null> {
		return this.repository.getById(id);
	}

	@Authorized()
	@Mutation(() => Product)
	async createProduct(@Arg('data') data: ProductInput): Promise<Product> {
		const product = await this.repository.create();
		product.update(data);
		await this.repository.save(product);

		return product;
	}

	@Authorized()
	@Mutation(() => Product)
	async updateProduct(
		@Arg('id') id: string,
		@Arg('data') data: ProductInput,
	): Promise<Product> {
		const product = await this.repository.getById(id);
		if (!product) {
			throw new Error('Product not found');
		}
		product.update(data);
		await this.repository.save(product);
		return product;
	}

	@Authorized()
	@Mutation(() => Product)
	async deleteProduct(@Arg('id') id: string): Promise<Product> {
		const product = await this.repository.getById(id);
		if (!product) {
			throw new Error('Product not found');
		}
		await this.repository.delete(id);
		return product;
	}
}
