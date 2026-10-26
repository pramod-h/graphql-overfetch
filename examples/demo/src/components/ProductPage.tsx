import { useQuery } from '@apollo/client';
import { GET_PRODUCT } from '../graphql/queries';

export function ProductPage({ sku }: { sku: string }) {
  const { data, loading } = useQuery(GET_PRODUCT, { variables: { sku } });
  if (loading || !data) return null;
  const { product } = data;

  return (
    <article>
      <h1>{product.name}</h1>
      <p>
        {product.price.value} {product.price.currency}
      </p>
      {product.images.map((img) => (
        <img key={img.url} src={img.url} alt={img.alt} />
      ))}
    </article>
  );
}
