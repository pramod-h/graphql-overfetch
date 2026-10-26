import { gql } from '@apollo/client';

export const PRODUCT_CARD = gql`
  fragment ProductCard on Product {
    id
    name
    price { value currency }
    thumbnail { url alt }
  }
`;

export const GET_PRODUCT = gql`
  query GetProduct($sku: String!) {
    product(sku: $sku) {
      sku
      name
      description
      price { value currency }
      images { url alt width height }
      reviews { rating text author createdAt }
    }
  }
`;

export const GET_CART = gql`
  query GetCart {
    cart { id totalQuantity }
  }
`;

export const GET_WISHLIST = gql`
  query GetWishlist {
    wishlist { id items { id product { ...ProductCard } } }
  }
  ${PRODUCT_CARD}
`;

export const PRODUCT_SEO = gql`
  fragment ProductSeo on Product {
    metaTitle
    metaDescription
  }
`;
