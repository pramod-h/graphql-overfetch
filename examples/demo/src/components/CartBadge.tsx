import { useQuery } from '@apollo/client';
import { GET_CART } from '../graphql/queries';

export function CartBadge() {
  const { data } = useQuery(GET_CART);
  return <a href={`/cart/${data?.cart?.id}`}>{data?.cart?.totalQuantity ?? 0}</a>;
}
