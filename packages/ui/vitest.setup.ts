import '@testing-library/jest-dom/vitest';

import { setProjectAnnotations } from '@storybook/react-vite';

import * as preview from './.storybook/preview';

setProjectAnnotations([preview]);
