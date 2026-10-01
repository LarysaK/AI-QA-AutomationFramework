import type { User } from '../../domain/types';
import { html } from '../html';
import { renderPage } from '../layout';

export interface ErrorPage {
  readonly heading: string;
  readonly message: string;
}

export function renderErrorPage(user: User | undefined, page: ErrorPage): string {
  return renderPage({
    title: page.heading,
    user,
    body: html`
      <section class="card" aria-labelledby="error-heading">
        <h1 id="error-heading">${page.heading}</h1>
        <p>${page.message}</p>
        <p><a href="/">Go to start page</a></p>
      </section>
    `,
  });
}

export const FORBIDDEN_PAGE: ErrorPage = {
  heading: 'Forbidden',
  message: 'You do not have permission to perform this action.',
};

export const NOT_FOUND_PAGE: ErrorPage = {
  heading: 'Not found',
  message: 'The page or request you are looking for does not exist.',
};

export const SERVER_ERROR_PAGE: ErrorPage = {
  heading: 'Something went wrong',
  message: 'An unexpected error occurred. Please try again.',
};
